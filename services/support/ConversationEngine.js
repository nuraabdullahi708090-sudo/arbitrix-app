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
 *     keyboard: [{ key, url }]  - optional inline URL buttons (trust answers)
 *     confident: boolean  - whether the reply is a real answer (drives the
 *                           operator notification status)
 *     humanRequested: boolean - the customer explicitly asked for a person
 *     nextState: object   - what to persist for the next turn
 *   }
 *
 * SUBJECTS THE DIALOGUE OWNS (the rest goes to the knowledge/AI layer):
 *   deposits, withdrawals, onboarding, referrals/partners, deposits tutorials,
 *   TRUST & LEGITIMACY (scam / legit / registered / verify the registration),
 *   the platform explanation, TRADING PERFORMANCE (returns, daily profit,
 *   guarantees) and the short conversational replies that follow any of them.
 *   Facts are never invented here: the trust answer only states what the
 *   published business-registration page shows, and the performance answer
 *   quotes no figure at all.
 *
 * Short replies are ONLY interpreted through `state.pending` (the expected answer
 * type of the question the bot actually asked). With no pending question a bare
 * "yes" is never guessed at: the engine asks a clarifying question instead.
 *
 * SOCIAL CONVERSATION
 * Acknowledgements ("ok", "got it"), positive feedback ("good", "great"),
 * gratitude ("thank you") and polite closures ("you're welcome") are recognised
 * over the WHOLE message and answered with one short courtesy. They are only
 * read as courtesies when the bot is not waiting on a real step (see
 * isCourtesyState): inside a live workflow "ok" is still a confirmation. A
 * courtesy never re-opens a question the customer has finished with, so
 * completed exchanges end cleanly instead of replaying a stale prompt.
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

/**
 * Official pages. These are the ONLY destinations the trust/legitimacy answers
 * point at, and both are published pages of this application (no external
 * registry link exists on them, so none is invented here).
 */
const BUSINESS_REGISTRATION_URL = 'https://arbitrix.pro/business-registration';
const HOW_IT_WORKS_URL = 'https://arbitrix.pro/how-it-works';

/** Inline-keyboard buttons offered under a trust answer (URL buttons only). */
const TRUST_KEYBOARD = Object.freeze([
  Object.freeze({ key: 'btnBusiness', url: BUSINESS_REGISTRATION_URL }),
  Object.freeze({ key: 'btnHowItWorks', url: HOW_IT_WORKS_URL })
]);

const HOW_KEYBOARD = Object.freeze([
  Object.freeze({ key: 'btnHowItWorks', url: HOW_IT_WORKS_URL })
]);

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
  // "Would you like a quick guide on how Arbitrix works?" - asked after the
  // trust/legitimacy answer and after the earnings answer, so a bare "yes"
  // continues into the platform explanation instead of being guessed at.
  GUIDE_OFFER: 'guide.offer',
  ANYTHING_ELSE: 'anything_else',
  CLARIFY: 'clarify'
});

const PENDING_VALUES = Object.freeze(Object.keys(PENDING).map((k) => PENDING[k]));

const TOPICS = Object.freeze([
  'deposit', 'withdrawal', 'onboarding', 'partner', 'referral',
  'kyc', 'trading', 'account', 'human', 'general',
  // Legitimacy/registration conversations and trading-performance questions keep
  // their own topic so their follow-ups ("how do I verify?", "how?") continue the
  // right subject instead of restarting the whole answer.
  'trust', 'earnings'
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
  [PENDING.GUIDE_OFFER]: 'guideOfferQuestion',
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
// ------------------------------------------------------ social conversation ---

/**
 * Ordinary social conversation: acknowledgements ("ok", "got it"), positive
 * feedback ("good", "great"), gratitude ("thank you", "thanks a lot") and
 * polite closures ("you're welcome").
 *
 * WHY THIS IS SEPARATE FROM `affirm` / `ack`
 * `affirm` answers a yes/no question and `ack` is the LENIENT prefix match a
 * pending question accepts as a confirmation ("ok, sure"). Neither can decide
 * what to do when the bot is NOT waiting for a real answer: there "ok" and
 * "good" are courtesies, not instructions. Treating them as affirmations is what
 * produced the three reported symptoms - "ok" opened the help menu, "good" fell
 * through to the generic clarification fallback, and "thank you" replayed that
 * fallback after a "you're welcome".
 *
 * The match is FULLY ANCHORED over the whole message (after stripping
 * punctuation, symbols and emoji), so a question that merely CONTAINS one of the
 * words - "is trust wallet good?", "ok so how do I deposit?" - is never misread
 * as a courtesy. Combinations ("ok thanks", "great, thank you") are recognised.
 */
const SOCIAL_FLAVORS = Object.freeze({
  NEUTRAL: 'neutral',
  UNDERSTOOD: 'understood',
  POSITIVE: 'positive',
  GREAT: 'great',
  THANKS: 'thanks',
  THANKS_BIG: 'thanksBig',
  RECIPROCAL: 'reciprocal'
});

/**
 * Phrase lists per flavour. Each phrase belongs to exactly ONE bucket so the
 * reply is deterministic. pt is Brazilian Portuguese, ar is Modern Standard
 * Arabic; the Arabic and accented words are written as \u escapes to keep this
 * file ASCII (the repository's encoding rule).
 */
const SOCIAL_PHRASES = Object.freeze({
  neutral: Object.freeze([
    'ok', 'okay', 'okey', 'okie', 'alright', 'all right', 'alright then', 'ok then',
    'okay then', 'that is all', "that's all", 'thats all', 'that is it', "that's it",
    'thats it', 'we are done', "we're done", 'im done', "i'm done", 'noted',
    'certo', 'beleza', 'ta bom', 't\u00e1 bom', 'tudo certo', 'combinado', 'blz',
    'ta certo', 't\u00e1 certo',
    '\u062d\u0633\u0646\u0627', '\u062d\u0633\u0646\u064b\u0627', '\u0637\u064a\u0628',
    '\u062a\u0645\u0627\u0645', '\u0643\u0648\u064a\u0633', '\u0623\u0648\u0643\u064a',
    '\u0627\u0648\u0643\u064a'
  ]),
  understood: Object.freeze([
    'understood', 'i understand', 'i understood', 'got it', 'i got it', "i've got it",
    'ive got it', 'i see', 'makes sense', 'that makes sense', 'that is clear',
    "that's clear", 'thats clear', 'clear', 'understood thanks',
    'entendi', 'entendido', 'compreendi', 'compreendido', 'faz sentido', 'entendi tudo',
    '\u0641\u0647\u0645\u062a', '\u0641\u0647\u0645\u062a\u0647\u0627', '\u0645\u0641\u0647\u0648\u0645',
    '\u0645\u0641\u0647\u0648\u0645\u0629', '\u0648\u0627\u0636\u062d', '\u0648\u0627\u0636\u062d\u0629',
    '\u0645\u0646\u0637\u0642\u064a'
  ]),
  positive: Object.freeze([
    'good', 'very good', "that's good", 'thats good', 'that is good', 'sounds good',
    'nice', "that's nice", 'thats nice', 'perfect', "that's perfect", 'thats perfect',
    'excellent', 'helpful', "that's helpful", 'thats helpful', 'that is helpful',
    'it helps', 'that helps', 'great job',
    'bom', 'boa', 'muito bom', 'legal', 'show', 'bacana', 'joia', 'j\u00f3ia',
    'perfeito', 'excelente',
    '\u062c\u064a\u062f', '\u062c\u064a\u062f\u0627', '\u062c\u064a\u062f\u064b\u0627',
    '\u0645\u0645\u062a\u0627\u0632', '\u0623\u062d\u0633\u0646\u062a', '\u0627\u062d\u0633\u0646\u062a',
    '\u062c\u064a\u062f \u062c\u062f\u0627'
  ]),
  great: Object.freeze([
    'great', "that's great", 'thats great', 'that is great', 'wonderful', 'amazing',
    'awesome', 'brilliant', 'superb', 'fantastic', 'cool', 'lovely', 'splendid',
    'very nice', 'very helpful',
    '\u00f3timo', 'otimo', 'maravilha', 'maravilhoso', 'incr\u00edvel', 'incrivel',
    'fant\u00e1stico', 'fantastico', 'show de bola',
    '\u0631\u0627\u0626\u0639', '\u0639\u0638\u064a\u0645', '\u0645\u0630\u0647\u0644',
    '\u0631\u0647\u064a\u0628', '\u0645\u0645\u062a\u0627\u0632 \u062c\u062f\u0627',
    '\u0639\u0638\u064a\u0645 \u062c\u062f\u0627'
  ]),
  thanks: Object.freeze([
    'thanks', 'thank you', 'thank u', 'thankyou', 'thx', 'ty', 'cheers',
    'appreciate it', 'appreciate that', 'i appreciate it', 'much appreciated',
    'we appreciate it', 'thanks for the help', 'thanks for your help',
    'obrigado', 'obrigada', 'valeu', 'agradeco', 'agrade\u00e7o', 'grato', 'grata',
    '\u0634\u0643\u0631\u0627', '\u0634\u0643\u0631\u064b\u0627', '\u0623\u0634\u0643\u0631\u0643',
    '\u0627\u0634\u0643\u0631\u0643', '\u0645\u0634\u0643\u0648\u0631',
    '\u0634\u0643\u0631\u0627 \u0644\u0643'
  ]),
  thanksBig: Object.freeze([
    'thanks a lot', 'thanks so much', 'thank you so much', 'thank you very much',
    'many thanks', 'thanks very much', 'much thanks', 'really appreciate it',
    'truly appreciate it', 'i really appreciate it', 'thank you all', 'thanks a ton',
    'muito obrigado', 'muito obrigada', 'obrigado mesmo', 'obrigada mesmo',
    'valeu mesmo', 'agradeco muito', 'agrade\u00e7o muito', 'muito grato', 'muito grata',
    '\u0634\u0643\u0631\u0627 \u062c\u0632\u064a\u0644\u0627',
    '\u0634\u0643\u0631\u064b\u0627 \u062c\u0632\u064a\u0644\u064b\u0627',
    '\u0634\u0643\u0631\u0627 \u0644\u0643 \u062c\u062f\u0627',
    '\u0623\u0634\u0643\u0631\u0643 \u062c\u062f\u0627',
    '\u0627\u0634\u0643\u0631\u0643 \u062c\u062f\u0627',
    '\u0634\u0643\u0631\u0627 \u0645\u0646 \u0627\u0644\u0642\u0644\u0628'
  ]),
  reciprocal: Object.freeze([
    "you're welcome", 'you are welcome', 'your welcome', 'anytime', 'my pleasure',
    'it was my pleasure', 'happy to help', 'glad i could help', 'glad to help',
    'de nada', 'por nada', 'nao foi nada', 'n\u00e3o foi nada', 'imagina',
    'as ordens', '\u00e0s ordens', 'disponha',
    '\u0639\u0644\u0649 \u0627\u0644\u0631\u062d\u0628 \u0648\u0627\u0644\u0633\u0639\u0629',
    '\u0644\u0627 \u0645\u0634\u0643\u0644\u0629', '\u0644\u0627 \u0645\u0634\u0627\u0643\u0644',
    '\u0628\u0643\u0644 \u0633\u0631\u0648\u0631', '\u0627\u0644\u0639\u0641\u0648'
  ])
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest first, so "thank you so much" is tried before "thank you". */
function alternation(phrases) {
  return phrases.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
}

const SOCIAL_MATCHERS = (() => {
  const p = SOCIAL_PHRASES;
  const ackish = alternation([].concat(p.neutral, p.understood, p.positive, p.great));
  const thanksAlt = alternation([].concat(p.thanks, p.thanksBig));
  const big = alternation(p.thanksBig);
  const whole = (body) => new RegExp('^(?:' + body + ')$');
  const ackGroup = '(?:' + ackish + ')';
  const thanksGroup = '(?:' + thanksAlt + ')';
  return Object.freeze({
    thanksBig: whole(big),
    ackThenThanksBig: whole(ackGroup + ' (?:' + big + ')'),
    thanksBigThenAck: whole('(?:' + big + ') ' + ackGroup),
    thanks: whole(thanksAlt),
    ackThenThanks: whole(ackGroup + ' ' + thanksGroup),
    thanksThenAck: whole(thanksGroup + ' ' + ackGroup),
    reciprocal: whole(alternation(p.reciprocal)),
    understood: whole(alternation(p.understood)),
    positive: whole(alternation(p.positive)),
    great: whole(alternation(p.great)),
    neutral: whole(alternation(p.neutral))
  });
})();

/** Evaluation order. "Thanks" wins over the acknowledgement it is paired with. */
const SOCIAL_ORDER = Object.freeze([
  { matcher: 'thanksBig', flavor: SOCIAL_FLAVORS.THANKS_BIG },
  { matcher: 'ackThenThanksBig', flavor: SOCIAL_FLAVORS.THANKS_BIG },
  { matcher: 'thanksBigThenAck', flavor: SOCIAL_FLAVORS.THANKS_BIG },
  { matcher: 'thanks', flavor: SOCIAL_FLAVORS.THANKS },
  { matcher: 'ackThenThanks', flavor: SOCIAL_FLAVORS.THANKS },
  { matcher: 'thanksThenAck', flavor: SOCIAL_FLAVORS.THANKS },
  { matcher: 'reciprocal', flavor: SOCIAL_FLAVORS.RECIPROCAL },
  { matcher: 'understood', flavor: SOCIAL_FLAVORS.UNDERSTOOD },
  { matcher: 'positive', flavor: SOCIAL_FLAVORS.POSITIVE },
  { matcher: 'great', flavor: SOCIAL_FLAVORS.GREAT },
  { matcher: 'neutral', flavor: SOCIAL_FLAVORS.NEUTRAL }
]);

/**
 * Classify one message as ordinary social conversation, or null.
 *
 * Punctuation, symbols and emoji are stripped first ("Ok!" -> "ok"), then the
 * whole remaining text must equal a known phrase. The word limit is a second
 * guard: a courtesy is short, so a sentence that happens to contain "good" is
 * never swallowed by this classifier.
 */
function classifySocial(normalized) {
  const text = String(normalized || '')
    .toLowerCase()
    // Keep letters, digits, combining marks, spaces and apostrophes. The marks
    // matter for Arabic: a word carrying a tanween must not have it split off
    // into its own token.
    .replace(/[^\p{L}\p{M}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  if (text.split(' ').length > 6) return null;
  for (const entry of SOCIAL_ORDER) {
    const matcher = SOCIAL_MATCHERS[entry.matcher];
    if (matcher && matcher.test(text)) {
      return { flavor: entry.flavor, thanks: entry.flavor === SOCIAL_FLAVORS.THANKS
        || entry.flavor === SOCIAL_FLAVORS.THANKS_BIG };
    }
  }
  return null;
}

/**
 * Unambiguous "yes".
 *
 * Needed wherever an acknowledgement ("ok", "fine") and a confirmation ("yes")
 * must be told apart: answering "Is there anything else I can help you with?"
 * with "ok" means "no thanks, we're done", while "yes" means "there is". The
 * overlapping words (ok / alright / sure-adjacent / perfect / great / good /
 * cool) are deliberately NOT here - they are acknowledgements.
 */
const EXPLICIT_AFFIRM_RE = tokenRe([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'of course', 'definitely', 'absolutely',
  'certainly', 'correct', 'indeed', 'go ahead', 'please do', 'why not', 'please',
  'sim', 'pode ser', 'com certeza', 'correto', 'isso', 'vamos', 'claro',
  '\u0646\u0639\u0645', '\u0623\u062c\u0644', '\u0628\u0627\u0644\u062a\u0623\u0643\u064a\u062f',
  '\u0635\u062d\u064a\u062d', '\u0637\u0628\u0639\u0627', '\u0623\u0643\u064a\u062f'
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

/**
 * "I checked" - the answer a customer actually sends after the bot asks
 * "Would you like help with a specific withdrawal problem?".
 *
 * It is NOT an answer to a yes/no question (it neither confirms nor denies a
 * withdrawal problem), so it is interpreted separately and only inside a
 * transaction follow-up. It must never be read as "the withdrawal completed".
 */
const CHECKED_RE = /(?:^|[\s!?.,;:()"'’])(?:checked|i\s+checked|i\s+have\s+checked|i've\s+checked|yes\s+checked|already\s+checked|checked\s+it|i\s+did\s+check|verified|i\s+verified|verifiquei|j\u00e1\s+verifiquei|ja\s+verifiquei|checado|conferi|\u062a\u062d\u0642\u0642\u062a|\u0631\u0627\u062c\u0639\u062a|\u062a\u0645\s+\u0627\u0644\u062a\u062d\u0642\u0642)(?=[\s!?.,;:()"'’]|$)/;

/** The funds arrived / the customer already received them. */
const ARRIVED_RE = /(?:^|[\s!?.,;:()"'\u2019])(?:it\s+)?(?:has\s+|had\s+)?(?:arrived|received\s+it|i\s+(?:have\s+|got\s+)?received|funds?\s+(?:have\s+)?arrived|got\s+the\s+(?:money|funds)|already\s+received|j\u00e1\s+chegou|ja\s+chegou|chegou|j\u00e1\s+recebi|ja\s+recebi|recebi|j\u00e1\s+caiu|ja\s+caiu|\u0648\u0635\u0644\u062a|\u0648\u0635\u0644|\u0627\u0633\u062a\u0644\u0645\u062a|\u062a\u0645 \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645)(?=[\s!?.,;:()"'\u2019]|$)/;

const NEGATION_RE = /(?:\bnot\b|\bnever\b|\bn't\b|\bno\b|\bn\u00e3o\b|\bnao\b|\u0644\u0645\b|\u0644\u0627\b|\u063a\u064a\u0631)/i;

/** "I have a problem" - a reported issue, not a yes/no answer. */
const PROBLEM_RE = /(?:^|[\s!?.,;:()"'’])(?:i\s+have\s+(?:a\s+|an\s+)?(?:problem|issue)|there\s+is\s+a\s+problem|something\s+is\s+wrong|something\s+went\s+wrong|it\s+is\s+not\s+working|it\s+does\s?n'?o?t\s+work|not\s+working|problem|issue|trouble|tenho\s+um\s+problema|problema|deu\s+errado|\u0644\u062f\u064a\s+\u0645\u0634\u0643\u0644\u0629|\u0645\u0634\u0643\u0644\u0629)(?=[\s!?.,;:()"'’]|$)/;

/** Registration details that are NOT published on the registration page. */
const UNPUBLISHED_DETAIL_RE = /\baddress\b|\bphone\b|\btelephone\b|\bcontact\s+number\b|\btax\b|\bvat\b|\bemployees?\b|\bendere[c\u00e7]o\b|\btelefone\b|\u0639\u0646\u0648\u0627\u0646|\u0647\u0627\u062a\u0641/;
/** "Tell me more" - continue what the bot was explaining. */
const MORE_RE = /^(?:tell\s+me\s+more|more\s+details?|more\s+info(?:rmation)?|go\s+on|continue|and\s+then|explain\s+more|saber\s+mais|mais\s+detalhes|continue|\u0627\u0644\u0645\u0632\u064a\u062f|\u0623\u062e\u0628\u0631\u0646\u064a\s+\u0628\u0627\u0644\u0645\u0632\u064a\u062f)\s*[.!?]*$/;

/** "What next?" - the /next command said in words. */
const NEXT_RE = /^(?:what(?:'s|\s+is)?\s+next|what\s+now|and\s+next|next\s+step|next|e\s+agora|pr[o\u00f3]xim[oa]\s+passo|\u0645\u0627\s+\u0627\u0644\u062a\u0627\u0644\u064a|\u0627\u0644\u062e\u0637\u0648\u0629\s+\u0627\u0644\u062a\u0627\u0644\u064a\u0629)\s*[.!?]*$/;

/** Still processing - normal inside the published window, a problem after it. */
const STILL_PENDING_RE = /(?:^|[\s!?.,;:()"'\u2019])(?:still\s+pending|still\s+processing|still\s+waiting|pending|processing|in\s+progress|not\s+yet\s+arrived|waiting|ainda\s+(?:pendente|processando)|pendente|em\s+processamento|\u0645\u0639\u0644\u0642|\u0645\u0639\u0644\u0642\u0629|\u0642\u064a\u062f \u0627\u0644\u0645\u0639\u0627\u0644\u062c\u0629|\u0644\u0645 \u064a\u0635\u0644 \u0628\u0639\u062f)(?=[\s!?.,;:()"'\u2019]|$)/;

/** The customer reports that the money never arrived - needs a human. */
const NOT_RECEIVED_RE = /(?:^|[\s!?.,;:()"'\u2019])(?:not\s+(?:arrived|received)|haven'?t\s+received|have\s+not\s+received|did\s?n'?t\s+(?:arrive|receive)|did\s+not\s+(?:arrive|receive)|never\s+arrived|never\s+received|has\s?n'?o?t\s+arrived|no\s+funds|missing|n\u00e3o\s+(?:chegou|recebi)|nao\s+(?:chegou|recebi)|ainda\s+n\u00e3o\s+(?:chegou|recebi)|\u0644\u0645\s+\u064a\u0635\u0644|\u0644\u0645\s+\u0623\u0633\u062a\u0644\u0645|\u0644\u0645\s+\u0623\u0633\u062a\u0644\u0645\u0647\u0627|\u0645\u0641\u0642\u0648\u062f\u0629)(?=[\s!?.,;:()"'\u2019]|$)/;


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
    // The last two alternatives are ANCHORED on purpose: a bare "human" /
    // "humano" / "بشري" is how the bot tells the customer to ask for a person
    // (see depositCreditedYes), so it must be recognised - including with
    // punctuation or quotes around it - while "the bot is not human" must not.
    re: /\b(?:talk|speak|chat)\s+(?:to\s+)?(?:a\s+)?(?:human|person|agent|someone|representative)\b|\breal\s+(?:human|person)\b|\bhuman\s+(?:support|agent|help|please)\b|\b(?:help|assistance)\s+from\s+(?:a\s+)?human\b|\bconnect\s+me\s+(?:to|with)\b|\bi\s+(?:want|need)\s+(?:a\s+)?(?:human|agent|real\s+person)\b|\b(?:atendente|pessoa\s+real|suporte\s+humano)\b|\u0645\u0648\u0638\u0641|\u0634\u062e\u0635\s+\u062d\u0642\u064a\u0642\u064a|\u062f\u0639\u0645\s+\u0628\u0634\u0631\u064a|^[\s"'\u2018\u2019\u201c\u201d\u00ab\u00bb]*(?:human|agent|operator|representative|humano|atendente)\s*[.!?]*[\s"'\u2018\u2019\u201c\u201d\u00ab\u00bb]*$|^[\s"'\u2018\u2019\u201c\u201d\u00ab\u00bb]*\u0628\u0634\u0631\u064a\s*[.!?]*[\s"'\u2018\u2019\u201c\u201d\u00ab\u00bb]*$/
  },
  {
    // Fraud / lost funds. These must reach a human, never a procedural answer.
    intent: 'fraud',
    topic: 'account',
    re: /\b(?:hacked|hijacked|compromised|unauthori[sz]ed|someone\s+else\s+(?:has\s+)?(?:accessed|logged\s+in|used))\b|\baccount\s+(?:was\s+|is\s+|got\s+)?(?:hacked|stolen|compromised)\b|\bmy\s+(?:money|funds|balance|usdt)\s+(?:is\s+|was\s+)?(?:gone|missing|stolen|disappeared)\b|\b(?:lost|stole)\s+my\s+(?:money|funds|usdt)\b|\bi\s+(?:want|need)\s+my\s+(?:money|funds)\s+back\b|\bmoney\s+(?:is\s+)?gone\b|\b(?:i\s+was|i've\s+been|i\s+have\s+been|they|someone)\s+scammed\b|\bscammed\s+me\b|\bme\s+enganaram\b|\bme\s+aplicaram\s+um\s+golpe\b|\u062a\u0639\u0631\u0636\u062a\s+\u0644\u0644\u0646\u0635\u0628/
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
    re: /\bdeposit(?:ed|ing|s)?\b[^?]{0,50}\b(?:not|never|did\s?n[o']?t|does\s?n[o']?t|has\s?n[o']?t|have\s?n[o']?t|nothing|no)\b[^?]{0,30}\b(?:credit\w*|arriv\w*|receiv\w*|show\w*|appear\w*|reflect\w*|balance|confirm\w*)\b|\b(?:deposit|payment)\b[^?]{0,40}\b(?:stuck|pending|missing|fail\w*|problem|issue|delay\w*|expired|not\s+working)\b|\b(?:sent|transferred|paid)\b[^?]{0,50}\b(?:not|never|has\s?n[o']?t|have\s?n[o']?t|did\s?n[o']?t)\b[^?]{0,25}\b(?:credit\w*|arriv\w*|receiv\w*|show\w*|appear\w*|reflect\w*|confirm\w*)\b|\bbalance\s+(?:is\s+|was\s+)?(?:still\s+)?(?:zero|empty)\b|\bstill\b[^?]{0,20}\b(?:nothing|zero|empty|not|never)\b|\bstill\s+no\b/
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
    // ---------------------------------------------------- trust / legitimacy --
    // Ordered BEFORE kyc / deposit / trading / security / business / what_is:
    // "is arbitrix a scam" must answer the legitimacy question, not the account
    // safety FAQ, and "how do I verify your registration" must not be read as a
    // KYC question (the old `kyc` rule matched any "verify").
    //
    // The vocabulary is deliberately narrow: a bare "business", "money",
    // "company" or "registered" is NOT enough (see the false-positive tests).
    intent: 'trust_scam',
    topic: 'trust',
    re: /\bscam\w*\b|\blegit(?:imate)?\b|\bgenuine\b|\btrustworthy\b|\b(?:can|could|should)\s+i\s+trust\b|\btrust\s+(?:this|you|arbitrix|your\s+platform|the\s+platform)\b|\bnot\s+(?:a\s+)?(?:scam|fake)\b|\bfake\s+(?:platform|company|site|website|bot|app)\b|\b(?:are|is)\s+(?:you|arbitrix|this|it)\s+(?:a\s+)?(?:scam|real|genuine|legit|legitimate|safe)\b|\breal\s+(?:company|platform|business)\b|\bgolpe\b|\bconfi[aá]vel\b|\bposso\s+confiar\b|\bverdadeir[oa]s?\b|\bn\u00e3o\s+[e\u00e9]\s+golpe\b|\u0646\u0635\u0628|\u0627\u062d\u062a\u064a\u0627\u0644|\u0645\u0648\u062b\u0648\u0642|\u0623\u062b\u0642|\u0645\u0646\u0635\u0629\s+\u062d\u0642\u064a\u0642\u064a\u0629|\u0647\u0644\s+\u0623\u0646\u062a\u0645\s+\u0645\u0648\u062b\u0648\u0642\u0648\u0646/
  },
  {
    intent: 'trust_registration',
    topic: 'trust',
    re: /\b(?:are|is)\s+(?:you|arbitrix|this|it)\s+(?:a\s+)?registered\b|\bregistered\s+(?:company|business|entity|in\s+the)\b|\b(?:your|the)\s+registration\b|\bregistration\s+(?:number|details|certificate|documents?|papers?)\b|\bbusiness\s+(?:registration|certificate|licen[cs]e|details)\b|\bcompany\s+(?:registration|details|number|certificate)\b|\bcan\s+i\s+(?:verify|check|confirm|see)\b[^?]{0,45}\b(?:registration|company|business|certificate|details)\b|\bhow\s+(?:can|do)\s+i\s+(?:verify|check|confirm)\b[^?]{0,35}\b(?:you|arbitrix|company|business|registration)\b|\b(?:show|send)\s+me\s+(?:your|the)\s+(?:registration|certificate|documents?|licen[cs]e)\b|\bdo\s+you\s+have\s+(?:a\s+)?(?:business\s+)?(?:registration|certificate|licen[cs]e)\b|\bwhere\s+(?:is|are)\s+(?:your|you)\s+(?:company\s+)?registered\b|\bregistered\s+address\b|\bcompany\s+address\b|\bcompany\s+phone\b|\bkvk\b|\bchamber\s+of\s+commerce\b|\bregistrad[ao]\b|\bregistro\s+(?:da\s+|empresarial|comercial)\b|\bcomo\s+(?:eu\s+)?(?:posso\s+)?(?:verificar|confirmar)\b|\bcertificado\s+(?:da\s+)?empresa\b|\u0645\u0633\u062c\u0644\u0629|\u0633\u062c\u0644\s+\u062a\u062c\u0627\u0631\u064a|\u0634\u0647\u0627\u062f\u0629\s+\u0627\u0644\u062a\u0633\u062c\u064a\u0644|\u063a\u0631\u0641\u0629\s+\u0627\u0644\u062a\u062c\u0627\u0631\u0629|\u062a\u062d\u0642\u0642|\u0627\u0644\u062a\u0633\u062c\u064a\u0644\s+\u0627\u0644\u062a\u062c\u0627\u0631\u064a|\u0634\u0647\u0627\u062f\u0629/
  },
  {
    intent: 'trust_general',
    topic: 'trust',
    re: /\bwhy\s+should\s+i\s+(?:use|choose|trust)\b|\bwhat\s+makes\s+(?:you|arbitrix)\s+different\b|\bhow\s+long\s+(?:have|has)\s+(?:you|arbitrix)\b|\bsince\s+when\b|\bwhat\s+exactly\s+does\s+arbitrix\s+do\b|\bhow\s+(?:can|do)\s+i\s+know\b[^?]{0,25}\b(?:real|genuine|legit|legitimate|true)\b|\bpor\s+que\s+devo\s+(?:usar|escolher)\b|\bh[a\u00e1]\s+quanto\s+tempo\b|\u0644\u0645\u0627\u0630\u0627\s+\u064a\u062c\u0628|\u0645\u0646\u0630\s+\u0645\u062a\u0649/
  },
  {
    // -------------------------------------------------- earnings / returns --
    // Before deposit / trading_bot / minimum_balance / subscription: "how much
    // can I make?" must never be read as a deposit question, and "how much does
    // the bot make?" must not hit the trading-bot FAQ.
    intent: 'earnings',
    topic: 'earnings',
    re: /\bhow\s+much\s+(?:can|could|will|would|do|does|did)\s+(?:i|you|we|it|the\s+bot)\s+(?:make|earn|generate|profit)\b|\bhow\s+much\s+(?:profit|income|money)\b|\b(?:daily|monthly|weekly|yearly|annual)\s+(?:profit|return|income|earning)s?\b|\b(?:profit|return|income|earning)s?\s+(?:per|a|each)\s+(?:day|week|month|year)\b|\b(?:what|which)\s+(?:is|are)\s+the\s+(?:daily|expected|average|typical)\s+(?:profit|return|income|earnings|yield)\b|\bexpected\s+(?:profit|return|income|earnings)\b|\bis\s+(?:the\s+)?(?:profit|return|income)\s+guaranteed\b|\bguaranteed\s+(?:profit|returns?|income|earnings)\b|\bcan\s+i\s+earn\s+(?:every\s+day|daily|monthly|every\s+month)\b|\b(?:what|how\s+much)\s+percentage\b|\bquanto\s+(?:posso|vou|d[aá]\s+para)\s+(?:ganhar|lucrar)\b|\bquanto\s+(?:de\s+)?lucro\b|\blucro\s+(?:di[aá]rio|garantido|mensal)\b|\bganhar\s+(?:por\s+dia|todo\s+dia)\b|\bretorno\s+(?:di[aá]rio|mensal|garantido)\b|\u0643\u0645\s+\u0623\u0631\u0628\u0627\u062d|\u0643\u0645\s+\u064a\u0645\u0643\u0646\s+\u0623\u0646\s+\u0623\u0631\u0628\u062d|\u0627\u0644\u0631\u0628\u062d\s+\u0627\u0644\u064a\u0648\u0645\u064a|\u0623\u0631\u0628\u0627\u062d\s+\u0645\u0636\u0645\u0648\u0646\u0629|\u0627\u0644\u0631\u0628\u062d\s+\u0645\u0636\u0645\u0648\u0646|\u0645\u0636\u0645\u0648\u0646\u0629|\u0627\u0644\u0639\u0627\u0626\u062f\s+\u0627\u0644\u064a\u0648\u0645\u064a/
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
    // The plain "what is this platform / how does it work" explanation. Ordered
    // before `arbitrage` and `trading_bot` so "how does Arbitrix work" and
    // "what is multi-asset arbitrage" get the full explanation rather than a
    // keyword-specific FAQ entry.
    intent: 'platform',
    topic: 'general',
    re: /\bwhat\s+is\s+arbitrix\b|\bwhat\s+does\s+arbitrix\s+do\b|\bhow\s+does\s+arbitrix\s+work\b|\bhow\s+does\s+(?:the\s+)?(?:arbitrage|platform|arbitrix\s+bot)\s+work\b|\bmulti-?asset\s+arbitrage\b|\btell\s+me\s+(?:more|about)\b[^?]{0,25}\b(?:platform|arbitrix|arbitrage)\b|\babout\s+arbitrix\b|\bcomo\s+(?:a\s+)?arbitrix\s+funciona\b|\bo\s+que\s+[e\u00e9]\s+a\s+arbitrix\b|\bo\s+que\s+a\s+arbitrix\s+faz\b|\bme\s+fale\s+mais\b|\u0643\u064a\u0641\s+\u062a\u0639\u0645\u0644\s+arbitrix|\u0645\u0627\s+\u0647\u064a\s+arbitrix|\u0645\u0627\u0630\u0627\s+\u062a\u0641\u0639\u0644\s+arbitrix/
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
    re: /\b(?:keep\s+(?:my\s+)?account\s+safe|account\s+security|phishing)\b/
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

/**
 * States in which the bot is NOT waiting for a real answer.
 *
 *   null             - nothing was ever asked (or the exchange was closed)
 *   anything_else    - the conversation is at rest ("is there anything else?")
 *   clarify          - the bot's own fallback question, which is not a request
 *   withdraw.help    - a courtesy offer made AFTER the withdrawal guidance was
 *                      already delivered ("would you like help with a specific
 *                      problem?"), not a step the customer must complete
 *
 * Every other pending value is a genuine step ("Have you made your first
 * deposit yet?", "Which method: Paybis, Transak or Trust Wallet?"). There "ok"
 * is a confirmation, so it must keep flowing through answerPending.
 */
function isCourtesyState(pending) {
  return !pending
    || pending === PENDING.ANYTHING_ELSE
    || pending === PENDING.CLARIFY
    || pending === PENDING.WITHDRAW_HELP;
}

/** Which localized line answers each social flavour. */
const SOCIAL_LINE_KEYS = Object.freeze({
  neutral: 'socialAck',
  understood: 'socialUnderstood',
  positive: 'socialPositive',
  great: 'socialGreat',
  thanks: 'socialThanks',
  thanksBig: 'socialThanksBig',
  reciprocal: 'socialReciprocal'
});

/**
 * Answer ordinary social conversation.
 *
 * Two deliberate properties:
 *   1. The reply never repeats a question the customer just finished with. The
 *      old pending question is replaced by the neutral "anything else" state, so
 *      a later "yes" still works but the obsolete prompt is gone.
 *   2. A second courtesy in a row gets ONE short closing line instead of the
 *      same sentence again, so "ok" ... "ok" cannot ping-pong.
 */
function socialReply(a, prev, next) {
  const flavor = a && a.social && SOCIAL_LINE_KEYS[a.social.flavor]
    ? a.social.flavor
    : SOCIAL_FLAVORS.NEUTRAL;
  // The SAME courtesy twice in a row gets one short closing line instead of the
  // same sentence again ("thank you" ... "thank you" cannot ping-pong). A
  // different courtesy still gets its own natural reply, which is what makes the
  // "ok / good / thank you" sequence read like a conversation.
  const previous = String(prev.stage || '').indexOf('social') === 0 ? prev.socialFlavor : null;
  next.socialFlavor = flavor;
  if (previous && previous === flavor) {
    next.pending = null;
    next.stage = 'social.closed';
    return makeReply('social', [line('socialClosing')], next);
  }
  next.pending = PENDING.ANYTHING_ELSE;
  next.stage = 'social';
  return makeReply('social', [line(SOCIAL_LINE_KEYS[flavor])], next);
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
    // Set when a human operator actually replies, cleared by `/close`: the bot
    // must stay silent for the WHOLE takeover, not only the first message.
    humanActiveAt: null,
    // Which courtesy the bot last acknowledged ("neutral", "positive", "thanks"
    // ...). Used only to avoid repeating the identical line twice in a row.
    socialFlavor: null,
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
 * A stored message id, or null when there is no usable one.
 *
 * `Number(null)` and `Number('')` are both 0, which is finite - so a plain
 * Number.isFinite check turns "no id was recorded" into id 0. Downstream that
 * reads as a real, already-resolved message and suppresses the bot forever.
 * Message ids are positive, so anything else is treated as absent and the
 * timestamp fallback applies instead.
 */
function asMessageId(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
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
  base.handoffResolvedMessageId = asMessageId(value.handoffResolvedMessageId);
  base.humanActiveAt = asString(value.humanActiveAt, 40);
  base.socialFlavor = asString(value.socialFlavor, 20);
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
  // Ordinary social conversation, matched over the WHOLE message (see
  // classifySocial). Kept apart from `ack`/`affirm`, which answer questions.
  const social = classifySocial(normalized);
  // "yes" as opposed to "ok": only used where the two meanings differ.
  const explicitAffirm = EXPLICIT_AFFIRM_RE.test(normalized) && words.length <= 5;
  const greeting = GREETING_RE.test(normalized);
  const how = HOW_RE.test(bare);
  const really = REALLY_RE.test(bare);
  const completed = COMPLETED_RE.test(normalized);
  // Transaction follow-ups. These four are NOT yes/no answers: they are only
  // interpreted when the bot is waiting on a deposit/withdrawal follow-up, and
  // the guards in planTurn limit them to short messages.
  const shortReply = words.length > 0 && words.length <= 8;
  const checked = shortReply && CHECKED_RE.test(normalized);
  const pendingStill = shortReply && STILL_PENDING_RE.test(normalized);
  const notReceived = shortReply && NOT_RECEIVED_RE.test(normalized);
  // "not yet arrived" / "I haven't received it" CONTAIN the positive words, so a
  // positive match only counts when the message carries no negation at all.
  const arrivals = shortReply && ARRIVED_RE.test(normalized);
  const arrived = arrivals && !notReceived && !NEGATION_RE.test(normalized);
  // "no problem" is a DENIAL, not a reported problem.
  const problem = shortReply && PROBLEM_RE.test(normalized) && !DENY_RE.test(normalized);
  const more = MORE_RE.test(bare);
  const next = NEXT_RE.test(bare);

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
    social,
    explicitAffirm,
    greeting,
    how,
    really,
    completed,
    checked,
    arrived,
    pendingStill,
    notReceived,
    problem,
    more,
    next,
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

/**
 * The approved trust / legitimacy answer.
 *
 * Every claim in it is supported by the published registration page: the company
 * name, the KVK number and the certificate are on
 * https://arbitrix.pro/business-registration. It deliberately never says the
 * registration is a financial-services licence, never promises returns and never
 * pressures the customer to deposit.
 */
function trustReply(intent, next) {
  next.topic = 'trust';
  next.pending = PENDING.GUIDE_OFFER;
  next.stage = 'trust';
  return makeReply(intent, [
    line('trustIntro'),
    line('trustWhatWeDo'),
    line('trustExploreIntro'),
    line('trustPoints'),
    line('trustLinksIntro'),
    line('trustLinks'),
    line('trustClose'),
    // The third next step from the brief: a human, through the EXISTING handoff
    // (the "human" keyword), never a second mechanism.
    line('trustSupportLine'),
    line('trustQuestion')
  ], next, { keyboard: TRUST_KEYBOARD });
}

/**
 * The SHORT answer used for a follow-up inside an existing trust conversation
 * ("How do I verify the registration?", "Can you show me the certificate?").
 * Repeating the long answer here is what makes a bot feel scripted.
 */
function trustFollowupReply(intent, normalized, next) {
  next.topic = 'trust';
  next.pending = PENDING.ANYTHING_ELSE;
  next.stage = 'trust.followup';
  // Details the published page does NOT show (address, phone, tax numbers) are
  // never guessed: the bot says so and offers the team.
  if (UNPUBLISHED_DETAIL_RE.test(normalized || '')) {
    next.stage = 'trust.limit';
    next.handoffRequestedAt = next.updatedAt;
    return makeReply(intent, [line('trustLimits')], next, {
      confident: false,
      humanRequested: true
    });
  }
  const lines = [line('trustVerify')];
  // Only offer the certificate path when the customer actually asked for a
  // document: "show me the certificate" / "send me the documents".
  if (/certificat|document|paper|certid|\u0634\u0647\u0627\u062f|\u0648\u062b\u064a\u0642/.test(normalized || '')) {
    lines.push(line('trustCertificate'));
  }
  return makeReply(intent, lines, next, { keyboard: TRUST_KEYBOARD });
}

/** The "how does the platform work" explanation, with the official page. */
function platformReply(intent, next) {
  next.topic = 'general';
  next.pending = PENDING.GUIDE_OFFER;
  next.stage = 'platform';
  return makeReply(intent, [
    line('platformIntro'),
    line('platformBullets'),
    line('platformLink'),
    line('platformQuestion')
  ], next, { keyboard: HOW_KEYBOARD });
}

/**
 * Trading-performance questions.
 *
 * There is no fixed daily figure, no historical return and no percentage to
 * quote, so the answer explains what drives the result, says plainly that
 * nothing is guaranteed, and points at Demo Mode - never at a projection.
 */
function earningsReply(intent, next) {
  next.topic = 'earnings';
  next.pending = PENDING.GUIDE_OFFER;
  next.stage = 'earnings';
  return makeReply(intent, [
    line('earningsIntro'),
    line('earningsVaries'),
    line('earningsDemo'),
    line('earningsQuestion')
  ], next);
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
    // A greeting repeats the OPEN question once - but never the bot's own
    // clarification fallback, which is not a question the customer owes an answer
    // to (re-sending it here is the same stale replay as after a courtesy).
    if (prev.pending && prev.pending !== PENDING.CLARIFY) {
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

  // --- 3b. "tell me more" / "what next?" continue the CURRENT subject -----
  // Neither is a new question: they mean "keep going" or "what do I do now", so
  // they are answered from the topic/pending state instead of being classified.
  if (a.more) {
    if (prev.topic === 'trust' || prev.topic === 'earnings' || prev.pending === PENDING.GUIDE_OFFER) {
      return platformReply('more', next);
    }
    if (prev.topic && prev.topic !== 'general') return explainCurrentTopic(prev, next);
    return knowledgeReply('more', a.text, next);
  }
  if (a.next) {
    // "What next?" after an offer of the walkthrough is a yes to that offer.
    if (prev.pending === PENDING.GUIDE_OFFER) return platformReply('next', next);
    if (prev.pending) return makeReply('next', [line(QUESTION_KEYS[prev.pending])], next);
    next.pending = PENDING.CLARIFY;
    next.stage = 'clarify';
    return makeReply('next', [line('clarifyHelp')], next);
  }

  // --- 3c. ordinary social conversation ----------------------------------
  // A courtesy reply ("ok", "got it", "good", "thank you") is only read as a
  // courtesy when the bot is NOT waiting on a real step (see isCourtesyState).
  // Inside a live workflow "ok" is an answer, and step 4 keeps handling it as
  // one - so "ok" to "Have you made your first deposit yet?" still means yes.
  //
  // This runs BEFORE the pending-answer step, which is what stops a courtesy
  // from being escalated into the help menu, the generic clarification fallback
  // or a replay of the question the customer just finished with.
  if (a.social && !a.deny && !a.primary && !a.method && !a.how && !a.really
      && !a.more && !a.next && !a.completed && !a.checked && !a.arrived
      && !a.pendingStill && !a.notReceived && !a.problem
      && isCourtesyState(prev.pending)) {
    return socialReply(a, prev, next);
  }

  // --- 4. a short reply answers the pending question ---------------------
  const pendingTopic = topicOfPending(prev.pending);
  const switchesTopic = a.primaryTopic
    && pendingTopic
    && !topicsCompatible(pendingTopic, a.primaryTopic)
    && !['deposit', 'onboarding'].includes(a.primaryTopic);

  // The four transaction follow-up signals ("checked", "it arrived", "still
  // pending", "not received") are ONLY meaningful while the bot is waiting on a
  // deposit/withdrawal follow-up. In any other context they fall through to
  // their own intent or to the knowledge layer, so "still pending" can never
  // hijack an unrelated conversation.
  const transactionFollowup = (a.checked || a.arrived || a.pendingStill || a.notReceived || a.problem)
    && (prev.pending === PENDING.WITHDRAW_HELP
      || prev.pending === PENDING.CREDITED
      || prev.pending === PENDING.TRANSFER_DONE
      || prev.pending === PENDING.TUTORIAL_FOLLOWUP);

  if (prev.pending && (a.affirm || a.deny || a.ack || a.completed || transactionFollowup)
      && !switchesTopic) {
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
    // ------------------------------------------------ trust / legitimacy --
    // "Is Arbitrix a scam?" is answered once with the full approved response;
    // the follow-ups inside that conversation get the short answers instead of
    // the whole script again.
    case 'trust_scam':
      return trustReply('trust_scam', next);

    case 'trust_registration': {
      // A question that asks for the registration NUMBER, the certificate or
      // how to verify it gets the short, precise answer (the number is on the
      // page). A general "are you registered?" gets the trust overview once.
      const wantsDetail = prev.topic === 'trust'
        || /\bkvk\b|registration\s+number|company\s+number|n[u\u00fa]mero|certificat|certid|document|verif|confirm|check|\u0634\u0647\u0627\u062f|\u0631\u0642\u0645|\u0627\u0644\u062a\u062d\u0642\u0642/.test(a.normalized);
      return wantsDetail
        ? trustFollowupReply('trust_registration', a.normalized, next)
        : trustReply('trust_registration', next);
    }

    case 'trust_general':
      return prev.topic === 'trust'
        ? platformReply('trust_general', next)
        : trustReply('trust_general', next);

    // -------------------------------------------- earnings / performance --
    case 'earnings':
      return earningsReply('earnings', next);

    case 'platform':
      return platformReply('platform', next);

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
  // "How?" after the bot OFFERED the walkthrough is a yes, not a new topic.
  if (prev.pending === PENDING.GUIDE_OFFER) return platformReply('how', next);
  if (prev.topic === 'trust') return trustFollowupReply('how', '', next);
  if (prev.topic === 'earnings') return earningsReply('how', next);
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
      // "It has not arrived" / "still pending" about a DEPOSIT is an account
      // question the bot cannot answer from here: same guidance and handoff as
      // the existing status_check/deposit_problem intents.
      if (a.notReceived || a.pendingStill || a.problem) {
        next.topic = 'deposit';
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'problem';
        next.handoffRequestedAt = next.updatedAt;
        return makeReply('transfer_not_received', [line('paymentStatus')], next, {
          confident: false,
          humanRequested: true
        });
      }
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
      if (a.notReceived || a.pendingStill || a.problem) {
        next.topic = 'deposit';
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'problem';
        next.handoffRequestedAt = next.updatedAt;
        return makeReply('credited_still_pending', [line('paymentStatus')], next, {
          confident: false,
          humanRequested: true
        });
      }
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
      // The replies customers actually send here are not all yes/no answers.
      // "Checked" is the common one and it neither confirms nor denies a
      // problem, so it is acknowledged WITHOUT claiming the withdrawal
      // completed. A reported missing payment goes to the existing handoff.
      if (a.notReceived) {
        next.topic = 'withdrawal';
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'withdraw.problem';
        next.handoffRequestedAt = next.updatedAt;
        return makeReply('withdraw_not_received', [line('paymentStatus')], next, {
          confident: false,
          humanRequested: true
        });
      }
      if (a.pendingStill) {
        next.topic = 'withdrawal';
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'withdraw.pending';
        return makeReply('withdraw_still_pending', [line('withdrawStillPending')], next, {
          confident: false
        });
      }
      if (a.arrived) {
        next.topic = 'withdrawal';
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'closed';
        return makeReply('withdraw_arrived', [line('withdrawArrived')], next);
      }
      if (a.checked) {
        next.topic = 'withdrawal';
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'closed';
        return makeReply('withdraw_checked', [line('withdrawChecked')], next);
      }
      if (a.problem) {
        next.topic = 'withdrawal';
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'problem';
        next.handoffRequestedAt = next.updatedAt;
        return makeReply('withdraw_problem', [line('humanHandoff')], next, {
          confident: false,
          humanRequested: true
        });
      }
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

    case PENDING.GUIDE_OFFER:
      // "Yes" to "Would you like a quick guide on how Arbitrix works?" continues
      // into the platform explanation instead of asking what they want again.
      if (a.affirm || a.ack) {
        // EXCEPT when the explanation was the message that just closed with this
        // offer: replaying the whole explanation because the customer said "good"
        // is the same stale repetition as the clarify fallback. An explicit "yes"
        // / "sure" still continues (they asked for more), an acknowledgement is
        // answered as the courtesy it is.
        if (prev.stage === 'platform' && !a.explicitAffirm) {
          return socialReply(a, prev, next);
        }
        return platformReply('guide_offer', next);
      }
      if (a.deny) {
        next.pending = PENDING.ANYTHING_ELSE;
        next.stage = 'closed';
        return makeReply('guide_offer_no', [line('anythingElse')], next);
      }
      return repeatQuestion(prev, next);

    case PENDING.ANYTHING_ELSE:
      if (a.deny) {
        next.pending = null;
        next.stage = 'closed';
        return makeReply('close', [line('thanksClose')], next);
      }
      // "Ok" / "Good" / "Thank you" here is a courtesy, not a request for the
      // help menu: only an explicit "yes" means "I do want something else".
      if (a.social) return socialReply(a, prev, next);
      if (a.explicitAffirm) {
        // "Yes" to "anything else?" means the customer DOES want something else -
        // offer the topics rather than implying we failed to understand.
        next.pending = PENDING.CLARIFY;
        next.stage = 'clarify';
        return makeReply('more_help', [line('clarifyHelp')], next);
      }
      // Any other acknowledgement-shaped reply ("fine", "ok cool") is still a
      // courtesy, never a request to restart the conversation.
      if (a.ack || a.affirm) return socialReply(a, prev, next);
      return repeatQuestion(prev, next);

    case PENDING.CLARIFY:
      if (a.deny) {
        next.pending = null;
        next.stage = 'closed';
        return makeReply('close', [line('thanksClose')], next);
      }
      // Repeating the same "I may not have understood" text after a courtesy is
      // exactly the stale-fallback replay this branch used to produce.
      if (a.social) return socialReply(a, prev, next);
      if (a.explicitAffirm || a.ack || a.affirm) {
        // A "yes" here cannot answer the fallback question, so offer the topics
        // once instead of asking the same thing again.
        next.pending = PENDING.CLARIFY;
        next.stage = 'clarify';
        return makeReply('help', [line('clarifyHelp')], next);
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

/**
 * Customer commands that depend on the CONVERSATION STATE.
 *
 * `/tutorial`, `/progress` and `/next` are answered from the same stored state as
 * an ordinary message, so a customer can ask "where was I?" at any point. They
 * are informational: none of them clears the pending question, changes the topic
 * or invents account data - `/next` restates what the bot is waiting for, and
 * `/progress` reports only what the customer told this chat.
 */
function planCommand(name, { state } = {}) {
  const prev = normalizeState(state);
  const next = Object.assign({}, prev, {
    turns: prev.turns + 1,
    lastIntent: 'command:' + name,
    updatedAt: new Date().toISOString()
  });

  if (name === 'tutorial') {
    const lines = [line('tutorialMenu')];
    DEPOSIT_METHODS.forEach((id) => lines.push(tutorialLine(id)));
    lines.push(tutorialLine('withdrawal'));
    return makeReply('command:tutorial', lines, next, { tutorial: true });
  }

  if (name === 'progress') {
    const questionKey = prev.pending ? QUESTION_KEYS[prev.pending] : null;
    const method = DEPOSIT_METHODS.indexOf(prev.method) !== -1 ? prev.method : null;
    if (!questionKey && !method) {
      return makeReply('command:progress', [line('progressEmpty')], next);
    }
    const lines = [line('progressTitle')];
    if (method) lines.push(line('progressMethod', { method: TUTORIALS[method].label }));
    if (questionKey) {
      lines.push(line('progressWaiting'));
      lines.push(line(questionKey));
    }
    return makeReply('command:progress', lines, next);
  }

  if (name === 'next') {
    const questionKey = prev.pending ? QUESTION_KEYS[prev.pending] : null;
    if (!questionKey) return makeReply('command:next', [line('nextTopics')], next);
    const lines = [line('nextStepTitle')];
    const method = DEPOSIT_METHODS.indexOf(prev.method) !== -1 ? prev.method : null;
    if (method) lines.push(line('progressMethod', { method: TUTORIALS[method].label }));
    lines.push(line(questionKey));
    return makeReply('command:next', lines, next);
  }

  return null;
}

module.exports = {
  TUTORIALS,
  BUSINESS_REGISTRATION_URL,
  HOW_IT_WORKS_URL,
  TRUST_KEYBOARD,
  HOW_KEYBOARD,
  PENDING,
  PENDING_VALUES,
  TOPICS,
  DEPOSIT_METHODS,
  KNOWLEDGE_QUERIES,
  INTENT_RULES,
  NON_METHOD_INTENTS,
  METHOD_SELECTION_INTENTS,
  SOCIAL_FLAVORS,
  SOCIAL_PHRASES,
  emptyState,
  normalizeState,
  analyze,
  classifySocial,
  isCourtesyState,
  isMethodSelection,
  planTurn,
  planCommand
};
