'use strict';

/**
 * ConversationEngine - the deterministic dialogue layer of the Telegram support
 * bot.
 *
 * WHY THIS EXISTS
 * The bot used to treat every ordinary message independently: a short reply such
 * as "yes", "okay" or "thanks" matched no keyword, so the customer received the
 * generic acknowledgement (AI off) or "I do not have an approved answer" (AI on).
 * That is a context bug, not a keyword gap - the meaning of "yes" lives in the
 * question the bot asked immediately before it.
 *
 * This module keeps a small, explicit conversation state (the last question and
 * its expected answer type, the active topic, the chosen deposit method and the
 * facts the customer has already given) and decides - deterministically - what
 * the next reply should be. It is PURE: no I/O, no clock, no randomness, no
 * network, no database, so every branch is unit-testable and the same input
 * always produces the same plan.
 *
 * The engine does not invent product facts. Procedural replies tell the customer
 * what to do next and which tutorial to watch; any factual question it cannot
 * answer procedurally is returned as `knowledge` (a canonical English question)
 * so the existing approved-knowledge / AI layer answers it. That keeps one
 * source of truth for facts and one for dialogue.
 *
 * THE CONTRACT WITH THE CALLER
 *   planTurn({ text, state }) -> {
 *     handled:  boolean   - true when `lines` is the complete reply
 *     lines:    [{ key, vars }] - localized keys resolved by telegram-i18n
 *     tutorial: 'paybis' | 'transak' | 'trustwallet' | 'withdrawal' | null
 *     knowledge: string | null  - canonical question for the knowledge layer
 *     confident: boolean  - whether the reply is a real answer (drives the
 *                           operator notification status)
 *     humanRequested: boolean - the customer explicitly asked for a person
 *     nextState: object   - what to persist for the next turn
 *   }
 *
 * Short replies are ONLY interpreted through `state.pending` (the expected answer
 * type of the question the bot actually asked). With no pending question a bare
 * "yes" is never guessed at: the engine asks a clarifying question instead.
 */

const TUTORIALS = Object.freeze({
  paybis: Object.freeze({
    id: 'paybis',
    label: 'Paybis',
    url: 'https://t.me/ArbitrixAnnouncements/17'
  }),
  transak: Object.freeze({
    id: 'transak',
    label: 'Transak',
    url: 'https://t.me/ArbitrixAnnouncements/16'
  }),
  trustwallet: Object.freeze({
    id: 'trustwallet',
    label: 'Trust Wallet',
    url: 'https://t.me/ArbitrixAnnouncements/18'
  }),
  withdrawal: Object.freeze({
    id: 'withdrawal',
    label: 'Arbitrix withdrawal',
    url: 'https://t.me/ArbitrixAnnouncements/19'
  })
});

/** Questions the bot can ask. `pending` is the expected answer type. */
const PENDING = Object.freeze({
  REGISTERED: 'onboarding.registered',
  DEPOSITED: 'onboarding.deposited',
  DEPOSIT_WANT_HELP: 'deposit.want_help',
  HAS_CRYPTO: 'deposit.has_crypto',
  DEPOSIT_METHOD: 'deposit.method',
  TUTORIAL_FOLLOWUP: 'deposit.tutorial_followup',
  TRANSFER_DONE: 'deposit.transfer_done',
  CREDITED: 'deposit.credited',
  WITHDRAW_HELP: 'withdraw.help',
  PARTNER_INTEREST: 'partner.interest',
  ANYTHING_ELSE: 'anything_else',
  CLARIFY: 'clarify'
});

const PENDING_VALUES = Object.freeze(Object.keys(PENDING).map((k) => PENDING[k]));

const TOPICS = Object.freeze([
  'deposit', 'withdrawal', 'onboarding', 'partner', 'referral',
  'kyc', 'trading', 'account', 'human', 'general'
]);

const DEPOSIT_METHODS = Object.freeze(['paybis', 'transak', 'trustwallet']);

const STATE_VERSION = 1;
const MAX_TEXT = 600;

/**
 * A question the bot asked. Used to re-ask it after a courtesy reply ("thanks")
 * without restarting the conversation.
 */
const QUESTION_KEYS = Object.freeze({
  [PENDING.REGISTERED]: 'onboardRegisteredQuestion',
  [PENDING.DEPOSITED]: 'onboardDepositedQuestion',
  [PENDING.DEPOSIT_WANT_HELP]: 'depositWantHelpQuestion',
  [PENDING.HAS_CRYPTO]: 'depositIntro',
  [PENDING.DEPOSIT_METHOD]: 'depositMethodPrompt',
  [PENDING.TUTORIAL_FOLLOWUP]: 'depositAfterAck',
  [PENDING.TRANSFER_DONE]: 'depositCompletedAskTransfer',
  [PENDING.CREDITED]: 'depositCreditedQuestion',
  [PENDING.WITHDRAW_HELP]: 'withdrawHelpPrompt',
  [PENDING.PARTNER_INTEREST]: 'partnerOffer',
  [PENDING.ANYTHING_ELSE]: 'anythingElse',
  [PENDING.CLARIFY]: 'clarifyTopic'
});

/** Canonical approved-knowledge question for each informational intent. */
const KNOWLEDGE_QUERIES = Object.freeze({
  kyc: 'Do I need to verify my identity?',
  register: 'How do I get started?',
  login: 'I cannot log in',
  demo: 'How do I start Demo Mode?',
  live: 'How does Live Mode work?',
  trading_bot: 'How does the bot work?',
  bot_offline: 'Does the bot keep trading if I close the app?',
  minimum_balance: 'Is there a minimum trading balance?',
  promo_credit: 'What is the $50 promotional credit?',
  promo_cap: 'Why did my bot stop after making a profit?',
  referral: 'What is the referral program?',
  partner: 'What is the referral program?',
  referral_earnings: 'How do I use my referral earnings?',
  withdrawal: 'How do withdrawals work?',
  withdrawal_timing: 'How long does a withdrawal take?',
  deposit_minimum: 'What is the minimum deposit?',
  deposit_asset: 'Which cryptocurrency can I deposit?',
  payment_methods: 'What payment methods are supported?',
  subscription: 'How much is the subscription?',
  what_is: 'How does Arbitrix work?',
  arbitrage: 'What is arbitrage?',
  wrong_network: 'I sent funds to the wrong address or network',
  deposit_pending: 'My deposit is still pending',
  deposit_expired: 'My payment failed or expired',
  security: 'How do I keep my account safe?',
  countries: 'Which countries can use Arbitrix?',
  business: 'Is Arbitrix a registered company / can I see your registration?'
});

// ---------------------------------------------------------------- analysis ---

// Affirmatives are only ever interpreted through a pending question. The list is
// deliberately closed: a longer sentence that merely CONTAINS "yes" ("yes but I
// still cannot log in") is handled by its intent, not as a bare confirmation.
// A token must END the string or be followed by whitespace/punctuation. A plain
// \b cannot be used for the Portuguese/Arabic words: JavaScript's \b is
// ASCII-only, so it never matches after a non-ASCII letter ("شكرا", "não").
const TOKEN_END = '(?=[\\s!?.,;:()\\[\\]\"\'\u2019]|$)';
const tokenRe = (words) => new RegExp('^(?:' + words.join('|') + ')' + TOKEN_END);

// Short replies in every language the bot supports (en / pt / ar). They are only
// ever interpreted through a pending question - never guessed in isolation.
const AFFIRM_RE = tokenRe([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'sure', 'ok', 'okay', 'okey', 'alright', 'all right',
  'of course', 'definitely', 'absolutely', 'certainly', 'correct', 'right', 'indeed',
  'go ahead', 'please do', 'sounds good', 'why not', 'fine', 'perfect', 'great', 'good', 'cool',
  'sim', 'claro', 'pode ser', 'com certeza', 'correto', 'isso', 'beleza', 'tudo bem', 'vamos',
  '\u0646\u0639\u0645', '\u0623\u062c\u0644', '\u0628\u0627\u0644\u062a\u0623\u0643\u064a\u062f',
  '\u0635\u062d\u064a\u062d', '\u0637\u0628\u0639\u0627', '\u0623\u0643\u064a\u062f'
]);
const DENY_RE = tokenRe([
  'no', 'nope', 'nah', 'not yet', 'not really', 'not now', 'never', 'negative', 'none',
  'no thanks', 'no thank you',
  'n\u00e3o', 'nao', 'ainda n\u00e3o', 'ainda nao', 'negativo',
  '\u0644\u0627', '\u0644\u064a\u0633 \u0628\u0639\u062f', '\u0644\u064a\u0633 \u0627\u0644\u0622\u0646', '\u0643\u0644\u0627'
]);
const THANKS_RE = new RegExp('(?:^|[\\s!?.,;:()\\[\\]\"\'\u2019])(?:'
  + ['thanks', 'thank you', 'thankyou', 'thx', 'cheers', 'appreciate it', 'appreciate that',
    'much appreciated', 'obrigado', 'obrigada', 'valeu', 'agrade\u00e7o',
    '\u0634\u0643\u0631\u0627', '\u0634\u0643\u0631\u064b\u0627', '\u0623\u0634\u0643\u0631\u0643',
    '\u0645\u0634\u0643\u0648\u0631'].join('|') + ')' + TOKEN_END);
// "okay" is both an acknowledgement and, in answer to a yes/no question, a yes.
const ACK_RE = tokenRe([
  'ok', 'okay', 'okey', 'alright', 'all right', 'got it', 'i understand', 'understood',
  'i see', 'great', 'perfect', 'good', 'cool', 'nice', 'sure',
  'entendi', 'beleza', 'certo', 'combinado',
  '\u062d\u0633\u0646\u0627', '\u062d\u0633\u0646\u064b\u0627', '\u0641\u0647\u0645\u062a',
  '\u062a\u0645\u0627\u0645', '\u0645\u0648\u0627\u0641\u0642'
]);
const GREETING_RE = tokenRe([
  'hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'greetings',
  'ol\u00e1', 'ola', 'oi', 'bom dia', 'boa tarde', 'boa noite',
  '\u0645\u0631\u062d\u0628\u0627', '\u0645\u0631\u062d\u0628\u064b\u0627',
  '\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064a\u0643\u0645',
  '\u0623\u0647\u0644\u0627', '\u0623\u0647\u0644\u064b\u0627',
  '\u0635\u0628\u0627\u062d \u0627\u0644\u062e\u064a\u0631',
  '\u0645\u0633\u0627\u0621 \u0627\u0644\u062e\u064a\u0631'
]);
const HOW_RE = /^(?:how|how so|how do i|how does it work|how does that work|what do you mean|in what way|como|como assim|\u0643\u064a\u0641|\u0643\u064a\u0641 \u0630\u0644\u0643)\s*\??$/;
const REALLY_RE = /^(?:really|are you sure|is that true|seriously|s\u00e9rio|e mesmo|\u062d\u0642\u0627|\u0647\u0644 \u0647\u0630\u0627 \u0635\u062d\u064a\u062d)\s*\??$/;
const COMPLETED_RE = new RegExp('(?:^|[\\s!?.,;:()\\[\\]\"\'\u2019])(?:'
  + ['done', 'completed?', 'finished', 'already sent', 'sent it', 'sent the funds',
    'sent the money', 'sent usdt', 'i sent', 'i transferred', 'transferred it',
    'transferred the funds', 'payment sent',
    'conclu\u00eddo', 'concluido', 'j\u00e1 enviei', 'ja enviei', 'enviei', 'transferi',
    '\u062a\u0645', '\u0623\u0646\u062c\u0632\u062a', '\u0623\u0631\u0633\u0644\u062a',
    '\u062d\u0648\u0644\u062a'].join('|') + ')' + TOKEN_END);

const METHOD_RES = Object.freeze([
  { id: 'paybis', re: /\bpaybis\b/i },
  { id: 'transak', re: /\btransak\b/i },
  { id: 'trustwallet', re: /\btrust\s?wallet\b/i }
]);

/**
 * Intent rules, most specific first. `intent` doubles as the topic group used to
 * decide whether a short reply answers the pending question or changes subject.
 */
const INTENT_RULES = Object.freeze([
  {
    intent: 'human',
    topic: 'human',
    re: /\b(?:talk|speak|chat)\s+(?:to\s+)?(?:a\s+)?(?:human|person|agent|someone|representative)\b|\breal\s+(?:human|person)\b|\bhuman\s+(?:support|agent|help)\b|\bconnect\s+me\s+(?:to|with)\b|\bi\s+(?:want|need)\s+(?:a\s+)?(?:human|agent|real\s+person)\b|\b(?:atendente|pessoa\s+real|suporte\s+humano)\b|\u0645\u0648\u0638\u0641|\u0634\u062e\u0635\s+\u062d\u0642\u064a\u0642\u064a|\u062f\u0639\u0645\s+\u0628\u0634\u0631\u064a/
  },
  {
    // Fraud / lost funds. These must reach a human, never a procedural answer.
    intent: 'fraud',
    topic: 'account',
    re: /\b(?:hacked|hijacked|compromised|unauthori[sz]ed|someone\s+else\s+(?:has\s+)?(?:accessed|logged\s+in|used))\b|\baccount\s+(?:was\s+|is\s+|got\s+)?(?:hacked|stolen|compromised)\b|\bmy\s+(?:money|funds|balance|usdt)\s+(?:is\s+|was\s+)?(?:gone|missing|stolen|disappeared)\b|\b(?:lost|stole)\s+my\s+(?:money|funds|usdt)\b|\bi\s+(?:want|need)\s+my\s+(?:money|funds)\s+back\b|\bmoney\s+(?:is\s+)?gone\b/
  },
  {
    // A cancellation request cannot be executed by the bot, so it escalates.
    intent: 'withdrawal_cancel',
    topic: 'withdrawal',
    re: /\b(?:cancel|stop|reverse|undo|revert)\b[^?]{0,30}\b(?:withdraw\w*|payout)\b|\b(?:withdraw\w*|payout)\b[^?]{0,30}\b(?:cancel\w*|revers\w*|undo)\b/
  },
  {
    intent: 'withdrawal_problem',
    topic: 'withdrawal',
    re: /\bwithdraw\w*\b[^?]{0,50}\b(?:stuck|pending|not\s+(?:arriv\w*|receiv\w*)|did\s?n[o']?t|has\s?n[o']?t|fail\w*|missing|delay\w*|problem|issue|reject\w*)\b/
  },
  {
    intent: 'status_check',
    topic: 'deposit',
    re: /\b(?:did|has|have|is|was|when)\b[^?]{0,35}\b(?:deposit|withdrawal|payment|transaction)\b[^?]{0,35}\b(?:go\s+through|complete\w*|arriv\w*|process\w*|confirm\w*|credit\w*|receiv\w*|sent|reflect\w*)\b/
  },
  {
    intent: 'deposit_problem',
    topic: 'deposit',
    re: /\bdeposit(?:ed|ing|s)?\b[^?]{0,50}\b(?:not|never|did\s?n[o']?t|has\s?n[o']?t|have\s?n[o']?t|nothing|no|still)\b[^?]{0,30}\b(?:credit\w*|arriv\w*|receiv\w*|show\w*|appear\w*|reflect\w*|balance|confirm\w*)\b|\b(?:deposit|payment)\b[^?]{0,40}\b(?:stuck|pending|missing|fail\w*|problem|issue|delay\w*|expired|not\s+working)\b|\b(?:sent|transferred|paid)\b[^?]{0,50}\b(?:not|never|has\s?n[o']?t|have\s?n[o']?t|did\s?n[o']?t)\b[^?]{0,25}\b(?:credit\w*|arriv\w*|receiv\w*|show\w*|appear\w*|reflect\w*|confirm\w*)\b|\bbalance\s+(?:is\s+|was\s+)?(?:still\s+)?(?:zero|empty)\b|\bstill\s+(?:zero|empty|nothing)\b/
  },
  {
    intent: 'wrong_network',
    topic: 'deposit',
    re: /\b(?:wrong\s+(?:address|network)|sent\s+to\s+the\s+wrong|sent\s+on\s+the\s+wrong)\b/
  },
  {
    intent: 'account_problem',
    topic: 'account',
    re: /\b(?:locked\s+out|can\s?not\s+access\s+my\s+account|can\s?t\s+access\s+my\s+account|account\s+(?:is\s+)?(?:problem|issue|access|locked|hacked|compromised|suspended|banned|disabled|closed))\b|\baccount\b[^?]{0,25}\b(?:suspended|banned|disabled|closed|blocked)\b|\b(?:suspended|banned)\b[^?]{0,25}\baccount\b/
  },
  {
    intent: 'kyc',
    topic: 'kyc',
    re: /\b(?:kyc|identity|verify|verification|id\s+(?:check|document)|documents?)\b/
  },
  {
    // A provider is named in a complaint: that is not a method selection.
    intent: 'service_problem',
    topic: 'deposit',
    re: /\b(?:paybis|transak|trust\s?wallet)\b[^?]{0,45}\b(?:not\s+working|does\s?n[o']?t\s+work|is\s?n[o']?t\s+working|fail\w*|error\w*|problem\w*|issue\w*|declin\w*|reject\w*|stuck|blocked|scam\w*)\b|\b(?:problem|issue|error|fail\w*|trouble)\b[^?]{0,30}\b(?:paybis|transak|trust\s?wallet)\b/
  },
  {
    intent: 'deposit_method',
    topic: 'deposit',
    re: /\b(?:paybis|transak|trust\s?wallet)\b/
  },
  {
    intent: 'buy_crypto',
    topic: 'deposit',
    re: /\b(?:buy|purchase|get)\b[^?]{0,24}\b(?:crypto|usdt|bitcoin|btc|coin|tether)\b|\bdo\s?n[o']?t\s+have\s+(?:any\s+)?(?:crypto|usdt|bitcoin)\b|\bno\s+(?:crypto|usdt|bitcoin)\b|\b(?:credit|debit|bank)\s+card\b|\bwith\s+(?:my\s+)?card\b/
  },
  {
    intent: 'payment_methods',
    topic: 'deposit',
    re: /\bpayment\s+methods?\b|\bhow\s+(?:do|can)\s+i\s+pay\b|\b(?:bank|card)\s+payment\b/
  },
  {
    intent: 'deposit_asset',
    topic: 'deposit',
    re: /\b(?:usdt|trc\s?-?20|trc20|tron)\b|\bwallet\s+address\b|\bwhich\s+(?:coin|crypto|currency|cryptocurrency|network|asset)\b|\bnetwork\s+(?:should|do|to|for)\b|\b(?:deposit|send|sending)\b[^?]{0,24}\bnetwork\b/
  },
  {
    intent: 'deposit_minimum',
    topic: 'deposit',
    re: /\b(?:minimum|min)\b[^?]{0,24}\b(?:deposit|amount)\b|\bhow\s+much\s+(?:to|should\s+i)\s+deposit\b|\bdep[o\u00f3]sito\b[^?]{0,25}\bm[i\u00ed]nimo\b|\bm[i\u00ed]nimo\b[^?]{0,25}\bdep[o\u00f3]sito\b|\u0625\u064a\u062f\u0627\u0639[^?]{0,25}\u0627\u0644\u062d\u062f\s+\u0627\u0644\u0623\u062f\u0646\u0649|\u0627\u0644\u062d\u062f\s+\u0627\u0644\u0623\u062f\u0646\u0649[^?]{0,25}\u0625\u064a\u062f\u0627\u0639/
  },
  {
    intent: 'deposit',
    topic: 'deposit',
    re: /\b(?:deposit|depositing|fund\s+(?:my\s+)?account|add\s+(?:money|funds)|top\s?up|recharge|put(?:ting)?\s+(?:some\s+)?(?:money|funds)\s+(?:in|into)|transfer\s+(?:money|funds)|send\s+(?:money|funds))\b|\bdep[o\u00f3]sito\b|\bdepositar\b|\badicionar\s+(?:dinheiro|fundos)\b|\u0625\u064a\u062f\u0627\u0639|\u0623\u0648\u062f\u0639|\u0625\u0636\u0627\u0641\u0629\s+\u0623\u0645\u0648\u0627\u0644/
  },
  {
    intent: 'withdrawal_timing',
    topic: 'withdrawal',
    re: /\b(?:how\s+long|when)\b[^?]{0,30}\b(?:withdraw\w*|withdrawal)\b|\bwithdraw\w*\b[^?]{0,30}\b(?:take|time|arrive|processing)\b|\bquanto\s+tempo\b[^?]{0,30}\bsaque\b|\u0643\u0645\s+\u0645\u0646\s+\u0627\u0644\u0648\u0642\u062a|\u0645\u062a\u0649[^?]{0,20}\u0633\u062d\u0628/
  },
  {
    intent: 'withdrawal',
    topic: 'withdrawal',
    re: /\b(?:withdraw|withdrawal|withdrawing|cash\s?out|cashing\s+out|payout|take\s+out\s+(?:money|funds))\b|\bsacar\b|\bsaque\b|\u0633\u062d\u0628|\u0623\u0633\u062d\u0628/
  },
  {
    intent: 'new_user',
    topic: 'onboarding',
    re: /\b(?:new\s+(?:here|user)|i\s*(?:'m|am)\s+new|just\s+(?:signed\s+up|registered|joined)|what\s+(?:do|should)\s+i\s+do|how\s+do\s+i\s+start|how\s+to\s+start|where\s+do\s+i\s+start)\b/
  },
  {
    intent: 'register',
    topic: 'onboarding',
    re: /\b(?:register|registration|sign\s?up|create\s+(?:an?\s+)?account|open\s+(?:an?\s+)?account|new\s+account|first\s+steps|get\s+started)\b/
  },
  {
    intent: 'login',
    topic: 'account',
    re: /\b(?:log\s?in|sign\s?in|login|forgot\s+(?:my\s+)?password|reset\s+(?:my\s+)?password)\b/
  },
  {
    intent: 'demo',
    topic: 'trading',
    re: /\b(?:demo|virtual|practice|test\s+mode)\b/
  },
  {
    intent: 'live',
    topic: 'trading',
    re: /\b(?:live\s+mode|real\s+(?:money|funds)|switch\s+to\s+live|go\s+live)\b/
  },
  {
    intent: 'minimum_balance',
    topic: 'trading',
    re: /\b(?:minimum|min)\b[^?]{0,28}\b(?:balance|amount|capital|start|trade|trading)\b|\bhow\s+much\s+(?:do\s+i\s+need|to\s+start)\b|\bmta\b/
  },
  {
    intent: 'promo_cap',
    topic: 'trading',
    re: /\b(?:bot|trading)\b[^?]{0,30}\b(?:stopped|stop|paused|pause)\b|\bpromo\w*\s+(?:limit|cap)\b|\btrading\s+limit\b/
  },
  {
    intent: 'promo_credit',
    topic: 'trading',
    re: /\b(?:promo|promotional|bonus|free\s+credit|welcome\s+credit)\b|\$50\b|\b50\s+(?:usdt|dollars)\b/
  },
  {
    intent: 'partner',
    topic: 'partner',
    re: /\b(?:partner|partnership|affiliate|commission)\b/
  },
  {
    intent: 'referral_earnings',
    topic: 'referral',
    re: /\b(?:referral\s+(?:earnings|reward|bonus)|bonus\s+wallet)\b/
  },
  {
    intent: 'referral',
    topic: 'referral',
    re: /\b(?:referral|referrals|refer|referred|referring|invite|inviting|invitation)\b|\breferral\s+(?:code|link)\b/
  },
  {
    intent: 'earn',
    topic: 'partner',
    re: /\bhow\s+(?:can|do)\s+i\s+earn\b|\bearn\s+(?:extra|more|money)\b|\bother\s+ways\s+to\s+earn\b|\bpassive\s+income\b/
  },
  {
    intent: 'subscription',
    topic: 'account',
    re: /\b(?:subscription|arbitrix\s+pro|pro\s+plan|monthly\s+(?:fee|price|plan|payment))\b/
  },
  {
    intent: 'bot_offline',
    topic: 'trading',
    re: /\b(?:close|closing|closed)\s+(?:the\s+)?(?:app|tab|browser)\b|\bkeep\s+trading\b|\boffline\b|\bbrowser\s+closed\b/
  },
  {
    intent: 'arbitrage',
    topic: 'general',
    re: /\barbitrage\b/
  },
  {
    intent: 'trading_bot',
    topic: 'trading',
    re: /\b(?:trading\s+bot|bot|trade|trading|arbitrage|automatic\s+trading|robot|start\s+trading|first\s+trade)\b/
  },
  {
    intent: 'what_is',
    topic: 'general',
    re: /\b(?:what\s+is\s+arbitrix|how\s+does\s+arbitrix\s+work|about\s+arbitrix|how\s+it\s+works)\b/
  },
  {
    intent: 'countries',
    topic: 'account',
    re: /\b(?:which\s+countries|supported\s+countries|my\s+country|available\s+in)\b/
  },
  {
    intent: 'business',
    topic: 'account',
    re: /\b(?:registered\s+company|business\s+registration|kvk|chamber\s+of\s+commerce|company\s+certificate|licen[cs]e)\b/
  },
  {
    intent: 'security',
    topic: 'account',
    re: /\b(?:keep\s+(?:my\s+)?account\s+safe|account\s+security|phishing|scam)\b/
  },
  {
    intent: 'help',
    topic: 'general',
    re: /\b(?:help|assist)\b|\bajuda\b|\bpreciso\s+de\s+ajuda\b|\u0645\u0633\u0627\u0639\u062f\u0629|\u0633\u0627\u0639\u062f\u0646\u064a/
  }
]);

/**
 * Intents that must NEVER be answered with a provider tutorial.
 *
 * A provider name (Paybis / Transak / Trust Wallet) inside a complaint, a
 * withdrawal question or an account problem is a MENTION, not a selection. This
 * list is the guard that prevents "my deposit from paybis is missing" from being
 * answered with the Paybis tutorial and reported to the operator as BOT REPLIED.
 */
const NON_METHOD_INTENTS = Object.freeze([
  'withdrawal_problem', 'withdrawal_cancel', 'status_check', 'deposit_problem',
  'account_problem', 'fraud', 'wrong_network', 'withdrawal', 'withdrawal_timing', 'human'
]);

/** Intents that legitimately mean "I want the tutorial for this method". */
const METHOD_SELECTION_INTENTS = Object.freeze(['deposit', 'buy_crypto', 'deposit_method']);

/** A message that opens with a question word is a question, not a selection. */
const QUESTION_OPENER_RE = /^(?:is|are|was|were|does|do|did|can|could|should|would|will|why|what|when|where|which|who|how)\b/;

/** Topic groups that answer the same pending question (onboarding asks about deposits). */
const COMPATIBLE_TOPICS = Object.freeze({
  onboarding: ['onboarding', 'deposit'],
  deposit: ['deposit', 'onboarding']
});

function topicOfPending(pending) {
  if (!pending) return null;
  if (pending.indexOf('onboarding.') === 0) return 'onboarding';
  if (pending.indexOf('deposit.') === 0) return 'deposit';
  if (pending.indexOf('withdraw.') === 0) return 'withdrawal';
  if (pending.indexOf('partner.') === 0) return 'partner';
  return 'general';
}

function topicsCompatible(a, b) {
  if (!a || !b) return true;
  if (a === b) return true;
  if (a === 'general' || b === 'general') return true;
  const aList = COMPATIBLE_TOPICS[a] || [a];
  const bList = COMPATIBLE_TOPICS[b] || [b];
  return aList.some((t) => bList.indexOf(t) !== -1);
}

function emptyState() {
  return {
    v: STATE_VERSION,
    topic: null,
    stage: null,
    pending: null,
    method: null,
    hasCrypto: null,
    registered: null,
    deposited: null,
    transferred: null,
    credited: null,
    greeted: false,
    turns: 0,
    lastIntent: null,
    lastUpdateId: null,
    handoffRequestedAt: null,
    handoffResolvedAt: null,
    handoffResolvedMessageId: null,
    updatedAt: null
  };
}

function asBool(value) {
  return value === true ? true : value === false ? false : null;
}

function asString(value, max) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Turn ANY persisted value into a valid state.
 *
 * The column is JSONB, so a row could contain anything written by an older
 * version, a manual edit or a bug. A malformed value must never break a customer
 * reply: every field is clamped to its allowed domain and unknown values are
 * dropped.
 */
function normalizeState(raw) {
  const base = emptyState();
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      value = null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;

  base.topic = TOPICS.indexOf(value.topic) === -1 ? null : value.topic;
  base.stage = asString(value.stage, 40);
  base.pending = PENDING_VALUES.indexOf(value.pending) === -1 ? null : value.pending;
  base.method = DEPOSIT_METHODS.indexOf(value.method) === -1 ? null : value.method;
  base.hasCrypto = asBool(value.hasCrypto);
  base.registered = asBool(value.registered);
  base.deposited = asBool(value.deposited);
  base.transferred = asBool(value.transferred);
  base.credited = asBool(value.credited);
  base.greeted = value.greeted === true;
  base.turns = Number.isFinite(Number(value.turns)) ? Math.max(0, Math.min(9999, Math.floor(Number(value.turns)))) : 0;
  base.lastIntent = asString(value.lastIntent, 40);
  base.lastUpdateId = Number.isFinite(Number(value.lastUpdateId)) ? Number(value.lastUpdateId) : null;
  base.handoffRequestedAt = asString(value.handoffRequestedAt, 40);
  base.handoffResolvedAt = asString(value.handoffResolvedAt, 40);
  base.handoffResolvedMessageId = Number.isFinite(Number(value.handoffResolvedMessageId))
    ? Number(value.handoffResolvedMessageId)
    : null;
  base.updatedAt = asString(value.updatedAt, 40);
  return base;
}

/** Does this message read as an answer to the question the bot just asked? */
function isShortAnswer(a) {
  return a.words.length > 0 && a.words.length <= 8;
}

/**
 * Does this message actually SELECT a deposit method?
 *
 * "Paybis", "I want to deposit with paybis" and "use trust wallet please" select
 * it. "My deposit from paybis is missing", "my trust wallet is not working",
 * "I want to withdraw to my trust wallet" and "is paybis safe?" only mention it,
 * and must be routed by their real intent (usually a human handoff).
 */
function isMethodSelection(a) {
  if (!a || !a.method) return false;
  const intents = a.intents || [];
  // Any complaint / withdrawal / account / fraud / trading intent wins.
  if (intents.some((intent) => NON_METHOD_INTENTS.indexOf(intent) !== -1)) return false;
  // A message that also carries an unrelated intent is not a plain selection.
  const others = intents.filter((intent) => METHOD_SELECTION_INTENTS.indexOf(intent) === -1 && intent !== 'help');
  if (others.length > 0) return false;
  if (QUESTION_OPENER_RE.test(a.normalized)) return false;
  return !a.primary || METHOD_SELECTION_INTENTS.indexOf(a.primary) !== -1;
}

/**
 * Analyse one message.
 *
 * `normalized` keeps apostrophes (needed for "don't"), strips the punctuation
 * that changes a match, and lowercases. `words` is only used for length checks.
 */
function analyze(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim().slice(0, MAX_TEXT);
  const normalized = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const bare = normalized.replace(/[!?.,;:~*_"()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = bare ? bare.split(' ').filter(Boolean) : [];

  const affirm = AFFIRM_RE.test(normalized) && words.length <= 5;
  const deny = DENY_RE.test(normalized) && words.length <= 8;
  const thanks = THANKS_RE.test(normalized);
  const ack = ACK_RE.test(normalized) && words.length <= 5;
  const greeting = GREETING_RE.test(normalized);
  const how = HOW_RE.test(bare);
  const really = REALLY_RE.test(bare);
  const completed = COMPLETED_RE.test(normalized);

  let method = null;
  for (const candidate of METHOD_RES) {
    if (candidate.re.test(normalized)) { method = candidate.id; break; }
  }

  const matches = [];
  for (const rule of INTENT_RULES) {
    if (rule.re.test(normalized)) matches.push(rule);
  }
  const primary = matches.length ? matches[0] : null;

  return {
    text,
    normalized,
    words,
    affirm,
    deny,
    thanks,
    ack,
    greeting,
    how,
    really,
    completed,
    method,
    matches,
    primary: primary ? primary.intent : null,
    primaryTopic: primary ? primary.topic : null,
    intents: matches.map((m) => m.intent)
  };
}

// ------------------------------------------------------------- turn planning --

function line(key, vars) {
  return { key, vars: vars || {} };
}

function makeReply(intent, lines, nextState, extra) {
  return Object.assign({
    handled: true,
    intent: intent || null,
    lines: lines || [],
    tutorial: null,
    knowledge: null,
    confident: true,
    humanRequested: false,
    nextState
  }, extra || {});
}

function knowledgeReply(intent, query, nextState, extra) {
  return Object.assign({
    handled: false,
    intent: intent || null,
    lines: [],
    tutorial: null,
    knowledge: query,
    confident: false,
    humanRequested: false,
    nextState
  }, extra || {});
}

function tutorialLine(id) {
  return id === 'withdrawal'
    ? line('withdrawTutorialLink', { url: TUTORIALS.withdrawal.url })
    : line('depositTutorialLink', {
      method: TUTORIALS[id].label,
      url: TUTORIALS[id].url
    });
}

function planTurn({ text, state } = {}) {
  const prev = normalizeState(state);
  const a = analyze(text);
  const next = Object.assign({}, prev, {
    turns: prev.turns + 1,
    lastIntent: a.primary || prev.lastIntent,
    updatedAt: new Date().toISOString()
  });

  if (!a.text) {
    return knowledgeReply('empty', null, next, { confident: false });
  }

  // --- 1. an explicit request for a human always wins ---------------------
  if (a.primary === 'human') {
    next.topic = 'human';
    next.pending = PENDING.ANYTHING_ELSE;
    next.stage = 'human-requested';
    next.handoffRequestedAt = next.updatedAt;
    return makeReply('human', [line('humanHandoff')], next, {
      confident: false,
      humanRequested: true
    });
  }

  // --- 2. a greeting with no other subject -------------------------------
  // "hello", "hello?" and "hi there" are greetings; "hi, how do I deposit?" is a
  // greeting PLUS a question and must be answered as the question.
  const greetingRemainder = a.greeting
    ? a.normalized.slice(a.normalized.match(GREETING_RE)[0].length).replace(/^[\s,!.?;:\-]+/, '').trim()
    : '';
  const greetingFiller = /^(?:there|again|team|everyone|all|folks|guys)?$/;
  const greetingOnly = a.greeting && greetingFiller.test(greetingRemainder);
  if (greetingOnly && !a.primary && !a.method) {
    const first = !prev.greeted;
    next.greeted = true;
    if (prev.pending) {
      // Never restart an open question: greet and repeat it once.
      return makeReply('greeting', [
        line(first ? 'greetingFresh' : 'greetingAgain'),
        line(QUESTION_KEYS[prev.pending] || 'anythingElse')
      ], next);
    }
    next.pending = PENDING.ANYTHING_ELSE;
    next.stage = 'greeting';
    return makeReply('greeting', [line(first ? 'greetingFresh' : 'greetingAgain')], next);
  }

  // --- 3. "how?" / "really?" continue the CURRENT topic -------------------
  if (a.how) {
    return explainCurrentTopic(prev, next);
  }
  if (a.really) {
    // "Really?" can only confirm a CLAIM the bot actually made. After a question
    // there is nothing to confirm, so explain/re-ask instead of asserting "yes"
    // - and with no history at all ask what the customer needs.
    if (prev.pending === PENDING.ANYTHING_ELSE) {
      next.pending = PENDING.ANYTHING_ELSE;
      return makeReply('reassure', [line('reassure'), line('anythingElse')], next);
    }
    if (prev.pending) {
      return explainCurrentTopic(prev, next);
    }
    next.pending = PENDING.CLARIFY;
    next.stage = 'clarify';
    return makeReply('reallyUnknown', [line('clarifyTopic')], next, { confident: false });
  }

  // --- 4. a short reply answers the pending question ---------------------
  const pendingTopic = topicOfPending(prev.pending);
  const switchesTopic = a.primaryTopic
    && pendingTopic
    && !topicsCompatible(pendingTopic, a.primaryTopic)
    && !['deposit', 'onboarding'].includes(a.primaryTopic);

  if (prev.pending && (a.affirm || a.deny || a.ack || a.completed) && !switchesTopic) {
    return answerPending(prev, a, next);
  }

  // --- 5. a named deposit method selects that tutorial ONLY when the message
  //        really is a selection (see isMethodSelection) -------------------
  if (isMethodSelection(a)) {
    return sendMethodTutorial(a.method, next);
  }

  // --- 6. "I have completed it" -----------------------------------------
  if (a.completed && (prev.topic === 'deposit' || prev.pending)) {
    return depositCompleted(prev, next);
  }

  // --- 7. gratitude ------------------------------------------------------
  if (a.thanks && !a.primary) {
    if (prev.pending === PENDING.ANYTHING_ELSE || !prev.pending) {
      next.pending = null;
      next.stage = 'closed';
      return makeReply('thanks', [line('thanksClose')], next);
    }
    if (prev.pending === PENDING.TUTORIAL_FOLLOWUP || prev.pending === PENDING.TRANSFER_DONE) {
      // Keep the tutorial/step open: a courtesy "thanks" is not an answer.
      return makeReply('thanks', [line('thanksOpen'), line(QUESTION_KEYS[prev.pending])], next);
    }
    return makeReply('thanks', [line('thanksOpen'), line(QUESTION_KEYS[prev.pending] || 'anythingElse')], next);
  }

  // --- 8. a bare acknowledgement ----------------------------------------
  if (a.ack && !a.primary) {
    if (prev.pending === PENDING.TUTORIAL_FOLLOWUP) {
      return makeReply('ack', [line('depositAfterAck')], next);
    }
    if (prev.pending) {
      return makeReply('ack', [line('thanksOpen'), line(QUESTION_KEYS[prev.pending] || 'anythingElse')], next);
    }
    next.pending = PENDING.ANYTHING_ELSE;
    return makeReply('ack', [line('ackNoQuestion')], next);
  }

  // --- 9. explicit intents ----------------------------------------------
  if (a.primary) {
    return handleIntent(a, prev, next);
  }

  // --- 10. a longer message: let approved knowledge answer it ------------
  if (a.words.length >= 2) {
    return knowledgeReply('question', a.text, next);
  }

  // --- 11. nothing to go on ---------------------------------------------
  next.pending = PENDING.CLARIFY;
  next.stage = 'clarify';
  return makeReply('clarify', [line('clarifyTopic')], next, { confident: false });
}

function handleIntent(a, prev, next) {
  switch (a.primary) {
    case 'status_check':
      next.topic = 'deposit';
      next.pending = PENDING.ANYTHING_ELSE;
      next.stage = 'problem';
      next.handoffRequestedAt = next.updatedAt;
      return makeReply('status_check', [line('paymentStatus')], next, {
        confident: false
      });

    case 'withdrawal_problem':
    case 'withdrawal_cancel':
    case 'deposit_problem':
    case 'service_problem':
    case 'account_problem':
    case 'fraud':
      next.topic = a.primaryTopic || 'account';
      next.pending = PENDING.ANYTHING_ELSE;
      next.stage = 'problem';
      next.handoffRequestedAt = next.updatedAt;
      return makeReply(a.primary, [line('humanHandoff')], next, {
        confident: false
      });

    case 'wrong_network':
      next.topic = 'deposit';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('wrong_network', KNOWLEDGE_QUERIES.wrong_network, next, {
        confident: false
      });

    case 'buy_crypto':
      next.topic = 'deposit';
      next.hasCrypto = false;
      next.pending = PENDING.DEPOSIT_METHOD;
      next.stage = 'deposit.method';
      return makeReply('buy_crypto', [
        line('depositNeedCrypto'),
        line('depositMethodPrompt')
      ], next);

    case 'deposit_method': {
      // A question about a provider ("is paybis safe?") or a message that only
      // mentions one is answered by its real intent - never with a tutorial.
      if (a.method && isMethodSelection(a)) return sendMethodTutorial(a.method, next);
      const other = (a.intents || []).find((intent) => intent !== 'deposit_method' && intent !== 'deposit');
      if (other) return handleIntent(Object.assign({}, a, { primary: other }), prev, next);
      next.topic = 'deposit';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('deposit_method', a.text, next);
    }

    case 'deposit':
      next.topic = 'deposit';
      if (prev.hasCrypto === true) {
        next.pending = PENDING.TRANSFER_DONE;
        next.stage = 'deposit.transfer';
        return makeReply('deposit', [line('depositHaveCrypto'), line('depositAfterAck')], next);
      }
      if (prev.hasCrypto === false) {
        next.pending = PENDING.DEPOSIT_METHOD;
        next.stage = 'deposit.method';
        return makeReply('deposit', [line('depositNeedCrypto'), line('depositMethodPrompt')], next);
      }
      next.pending = PENDING.HAS_CRYPTO;
      next.stage = 'deposit.has_crypto';
      return makeReply('deposit', [line('depositIntro')], next);

    case 'withdrawal_timing':
      next.topic = 'withdrawal';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('withdrawal_timing', KNOWLEDGE_QUERIES.withdrawal_timing, next);

    case 'withdrawal':
      next.topic = 'withdrawal';
      next.pending = PENDING.WITHDRAW_HELP;
      next.stage = 'withdraw.intro';
      return makeReply('withdrawal', [
        line('withdrawIntro'),
        line('withdrawTiming'),
        line('withdrawHelpPrompt')
      ], next, { tutorial: 'withdrawal' });

    case 'new_user':
      next.topic = 'onboarding';
      next.pending = PENDING.REGISTERED;
      next.stage = 'onboarding.registered';
      return makeReply('new_user', [line('onboardRegisteredQuestion')], next);

    case 'register':
      next.topic = 'onboarding';
      next.pending = PENDING.DEPOSIT_WANT_HELP;
      next.stage = 'onboarding.register_help';
      return makeReply('register', [line('onboardCreateAccount'), line('depositWantHelpQuestion')], next);

    case 'login':
      next.topic = 'account';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('login', KNOWLEDGE_QUERIES.login, next, { confident: false });

    case 'kyc':
      next.topic = 'kyc';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('kyc', KNOWLEDGE_QUERIES.kyc, next);

    case 'demo':
      next.topic = 'trading';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('demo', KNOWLEDGE_QUERIES.demo, next);

    case 'live':
      next.topic = 'trading';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('live', KNOWLEDGE_QUERIES.live, next);

    case 'minimum_balance':
      next.topic = 'trading';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('minimum_balance', KNOWLEDGE_QUERIES.minimum_balance, next);

    case 'promo_cap':
      next.topic = 'trading';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('promo_cap', KNOWLEDGE_QUERIES.promo_cap, next);

    case 'promo_credit':
      next.topic = 'trading';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('promo_credit', KNOWLEDGE_QUERIES.promo_credit, next);

    case 'bot_offline':
      next.topic = 'trading';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('bot_offline', KNOWLEDGE_QUERIES.bot_offline, next);

    case 'trading_bot':
      next.topic = 'trading';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('trading_bot', KNOWLEDGE_QUERIES.trading_bot, next);

    case 'referral_earnings':
      next.topic = 'referral';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('referral_earnings', KNOWLEDGE_QUERIES.referral_earnings, next);

    case 'referral':
      next.topic = 'referral';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('referral', KNOWLEDGE_QUERIES.referral, next);

    case 'partner':
      next.topic = 'partner';
      next.pending = PENDING.PARTNER_INTEREST;
      next.stage = 'partner.offer';
      return makeReply('partner', [line('partnerOffer')], next, { confident: false });

    case 'earn':
      next.topic = 'partner';
      next.pending = PENDING.PARTNER_INTEREST;
      next.stage = 'partner.offer';
      return makeReply('earn', [line('partnerOffer')], next, { confident: false });

    case 'subscription':
      next.topic = 'account';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('subscription', KNOWLEDGE_QUERIES.subscription, next);

    case 'deposit_asset':
      next.topic = 'deposit';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('deposit_asset', KNOWLEDGE_QUERIES.deposit_asset, next);

    case 'deposit_minimum':
      next.topic = 'deposit';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('deposit_minimum', KNOWLEDGE_QUERIES.deposit_minimum, next);

    case 'payment_methods':
      next.topic = 'deposit';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('payment_methods', KNOWLEDGE_QUERIES.payment_methods, next);

    case 'what_is':
      next.topic = 'general';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('what_is', KNOWLEDGE_QUERIES.what_is, next);

    case 'arbitrage':
      next.topic = 'general';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('arbitrage', KNOWLEDGE_QUERIES.arbitrage, next);

    case 'countries':
      next.topic = 'account';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('countries', KNOWLEDGE_QUERIES.countries, next, { confident: false });

    case 'business':
      next.topic = 'account';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('business', KNOWLEDGE_QUERIES.business, next);

    case 'security':
      next.topic = 'account';
      next.pending = PENDING.ANYTHING_ELSE;
      return knowledgeReply('security', KNOWLEDGE_QUERIES.security, next);

    case 'help':
      next.topic = prev.topic || null;
      next.pending = PENDING.CLARIFY;
      next.stage = 'clarify';
      return makeReply('help', [line('clarifyHelp')], next);

    default:
      return knowledgeReply(a.primary, a.text, next);
  }
}

function sendMethodTutorial(method, next) {
  if (DEPOSIT_METHODS.indexOf(method) === -1) {
    next.topic = 'deposit';
    next.pending = PENDING.DEPOSIT_METHOD;
    next.stage = 'deposit.method';
    return makeReply('deposit_method', [line('depositMethodPromptAgain')], next);
  }
  next.topic = 'deposit';
  next.method = method;
  next.pending = PENDING.TUTORIAL_FOLLOWUP;
  next.stage = 'deposit.tutorial';
  return makeReply('deposit_method', [
    line('depositTutorialFollowUp')
  ], next, { tutorial: method, action: 'deposit-tutorial' });
}

function depositCompleted(prev, next) {
  next.topic = 'deposit';
  if (prev.pending === PENDING.TUTORIAL_FOLLOWUP || prev.pending === PENDING.TRANSFER_DONE || !prev.pending) {
    next.pending = PENDING.TRANSFER_DONE;
    next.stage = 'deposit.transfer';
    next.transferred = true;
    return makeReply('deposit_completed', [line('depositCompletedAskTransfer')], next);
  }
  if (prev.pending === PENDING.CREDITED) {
    next.pending = PENDING.ANYTHING_ELSE;
    next.transferred = true;
    return makeReply('deposit_completed', [line('depositCreditedQuestion')], next);
  }
  next.pending = PENDING.ANYTHING_ELSE;
  return makeReply('deposit_completed', [line('depositCompletedAskTransfer')], next);
}

function explainCurrentTopic(prev, next) {
  const method = prev.method;
  switch (prev.topic) {
    case 'deposit':
      if (method) {
        // "How?" AFTER a tutorial is a request for help with the steps - answer it
        // instead of re-sending the same link.
        next.topic = 'deposit';
        next.pending = PENDING.TUTORIAL_FOLLOWUP;
        next.stage = 'deposit.tutorial';
        return makeReply('how', [line('tutorialHow')], next);
      }
      if (prev.hasCrypto === false) {
        next.topic = 'deposit';
        next.pending = PENDING.DEPOSIT_METHOD;
        return makeReply('how', [line('depositNeedCrypto'), line('depositMethodPrompt')], next);
      }
      if (prev.hasCrypto === true) {
        next.topic = 'deposit';
        next.pending = PENDING.TRANSFER_DONE;
        return makeReply('how', [line('depositHaveCrypto'), line('depositAfterAck')], next);
      }
      next.topic = 'deposit';
      next.pending = PENDING.HAS_CRYPTO;
      return makeReply('how', [line('depositIntro')], next);
    case 'withdrawal':
      next.topic = 'withdrawal';
      next.pending = PENDING.WITHDRAW_HELP;
      return makeReply('how', [line('withdrawIntro'), line('withdrawHelpPrompt')], next, { tutorial: 'withdrawal' });
    case 'partner':
      next.topic = 'partner';
      next.pending = PENDING.ANYTHING_ELSE;
      return makeReply('how', [line('partnerHow'), line('anythingElse')], next);
    case 'referral':
      next.topic = 'partner';
      next.pending = PENDING.ANYTHING_ELSE;
      return makeReply('how', [line('partnerHow'), line('anythingElse')], next);
    case 'onboarding':
      next.topic = 'onboarding';
      next.pending = PENDING.REGISTERED;
      return makeReply('how', [line('onboardRegisteredQuestion')], next);
    default:
      next.pending = PENDING.CLARIFY;
      return makeReply('how', [line('clarifyTopic')], next, { confident: false });
  }
}

function answerPending(prev, a, next) {
  const pending = prev.pending;
  next.topic = prev.topic || topicOfPending(pending);
  next.pending = pending;

  switch (pending) {
    case PENDING.REGISTERED:
      if (a.affirm || a.ack) {
        next.registered = true;
        next.pending = PENDING.DEPOSITED;
        next.stage = 'onboarding.deposited';
        return makeReply('registered', [line('onboardRegisteredYes')], next);
      }
      if (a.deny) {
        next.registered = false;
        next.pending = PENDING.DEPOSIT_WANT_HELP;
        next.stage = 'onboarding.register_help';
        return makeReply('not_registered', [line('onboardRegisteredNo')], next);
      }
      return repeatQuestion(prev, next);

    case PENDING.DEPOSITED:
      if (a.affirm || a.ack) {
        next.deposited = true;
        next.pending = PENDING.CREDITED;
        next.stage = 'onboarding.credited';
        return makeReply('deposited', [line('onboardDepositedYes')], next);
      }
      if (a.deny) {
        next.deposited = false;
        next.pending = PENDING.HAS_CRYPTO;
        next.stage = 'deposit.has_crypto';
        next.topic = 'deposit';
        return makeReply('not_deposited', [line('onboardDepositedNo')], next);
      }
      return repeatQuestion(prev, next);

    case PENDING.DEPOSIT_WANT_HELP:
      if (a.affirm || a.ack) {
        next.pending = PENDING.HAS_CRYPTO;
        next.topic = 'deposit';
        next.stage = 'deposit.has_crypto';
        return makeReply('deposit_help', [line('depositIntro')], next);
      }
      if (a.deny) {
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'closed';
        return makeReply('no_deposit_help', [line('anythingElse')], next);
      }
      return repeatQuestion(prev, next);

    case PENDING.HAS_CRYPTO:
      if (a.affirm || a.ack) {
        next.hasCrypto = true;
        next.pending = PENDING.TRANSFER_DONE;
        next.topic = 'deposit';
        next.stage = 'deposit.transfer';
        return makeReply('has_crypto', [line('depositHaveCrypto'), line('depositAfterAck')], next);
      }
      if (a.deny) {
        next.hasCrypto = false;
        next.pending = PENDING.DEPOSIT_METHOD;
        next.topic = 'deposit';
        next.stage = 'deposit.method';
        return makeReply('no_crypto', [line('depositNeedCrypto'), line('depositMethodPrompt')], next);
      }
      return repeatQuestion(prev, next);

    case PENDING.DEPOSIT_METHOD:
      if (a.method) return sendMethodTutorial(a.method, next);
      next.pending = PENDING.DEPOSIT_METHOD;
      return makeReply('deposit_method', [line('depositMethodPromptAgain')], next);

    case PENDING.TUTORIAL_FOLLOWUP:
      if (a.completed) return depositCompleted(prev, next);
      if (a.deny) {
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'deposit.tutorial';
        return makeReply('tutorial_not_done', [line('anythingElse')], next);
      }
      next.pending = PENDING.TRANSFER_DONE;
      next.stage = 'deposit.transfer';
      return makeReply('tutorial_followup', [line('depositAfterAck')], next);

    case PENDING.TRANSFER_DONE:
      if (a.affirm || a.ack || a.completed) {
        next.transferred = true;
        next.pending = PENDING.CREDITED;
        next.stage = 'deposit.credited';
        return makeReply('transfer_done', [line('depositTransferYes')], next);
      }
      if (a.deny) {
        next.transferred = false;
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'deposit.transfer';
        return makeReply('transfer_pending', [prev.method
          ? line('depositTransferNo', { method: methodLabel(prev.method) })
          : line('depositTransferNoGeneric')], next);
      }
      return repeatQuestion(prev, next);

    case PENDING.CREDITED:
      if (a.affirm || a.ack) {
        next.credited = true;
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'closed';
        return makeReply('credited', [line('depositCreditedYes')], next);
      }
      if (a.deny) {
        next.credited = false;
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'closed';
        return makeReply('not_credited', [line('depositCreditedNo')], next, { confident: false });
      }
      return repeatQuestion(prev, next);

    case PENDING.WITHDRAW_HELP:
      if (a.affirm || a.ack) {
        next.topic = 'withdrawal';
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'withdraw.problem';
        next.handoffRequestedAt = next.updatedAt;
        return makeReply('withdraw_help', [line('humanHandoff')], next, {
          confident: false,
          humanRequested: true
        });
      }
      if (a.deny) {
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'closed';
        return makeReply('withdraw_no_help', [line('anythingElse')], next);
      }
      return repeatQuestion(prev, next);

    case PENDING.PARTNER_INTEREST:
      if (a.affirm || a.ack) {
        next.topic = 'partner';
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'partner.how';
        return makeReply('partner_yes', [line('partnerHow'), line('anythingElse')], next);
      }
      if (a.deny) {
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'closed';
        return makeReply('partner_no', [line('partnerDecline')], next);
      }
      return repeatQuestion(prev, next);

    case PENDING.ANYTHING_ELSE:
      if (a.deny) {
        next.pending = null;
        next.stage = 'closed';
        return makeReply('close', [line('thanksClose')], next);
      }
      if (a.affirm || a.ack) {
        // "Yes" to "anything else?" means the customer DOES want something else -
        // offer the topics rather than implying we failed to understand.
        next.pending = PENDING.CLARIFY;
        next.stage = 'clarify';
        return makeReply('more_help', [line('clarifyHelp')], next);
      }
      return repeatQuestion(prev, next);

    case PENDING.CLARIFY:
      if (a.deny) {
        next.pending = null;
        next.stage = 'closed';
        return makeReply('close', [line('thanksClose')], next);
      }
      next.pending = PENDING.CLARIFY;
      return makeReply('clarify', [line('clarifyTopic')], next, { confident: false });

    default:
      return repeatQuestion(prev, next);
  }
}

function methodLabel(method) {
  return TUTORIALS[method] ? TUTORIALS[method].label : 'deposit';
}

function repeatQuestion(prev, next) {
  next.pending = prev.pending;
  next.topic = prev.topic;
  return makeReply('repeat', [
    line('ackNoQuestion'),
    line(QUESTION_KEYS[prev.pending] || 'anythingElse')
  ], next);
}

module.exports = {
  TUTORIALS,
  PENDING,
  PENDING_VALUES,
  TOPICS,
  DEPOSIT_METHODS,
  KNOWLEDGE_QUERIES,
  INTENT_RULES,
  NON_METHOD_INTENTS,
  METHOD_SELECTION_INTENTS,
  emptyState,
  normalizeState,
  analyze,
  isMethodSelection,
  planTurn
};
