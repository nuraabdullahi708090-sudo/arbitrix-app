'use strict';

/**
 * Telegram-specific localization for the Arbitrix support bot (en / pt / ar).
 *
 * WHY THIS EXISTS
 * The web app has a ~1,400-key dictionary in public/index.html, but the bot
 * sends only a handful of fixed strings and its replies are composed in a
 * different process. Copying that dictionary would create two sources of truth
 * that can silently drift, so the bot owns a SMALL dictionary containing only
 * the strings it actually sends.
 *
 * WHAT IS LOCALIZED HERE (customer-facing)
 *   help, acknowledgement, tutorialCaption, escalationAck, textOnly, chatId, languagePrompt,
 *   languageSet, languageUnsupported, and the fixed AI-layer fallbacks
 *   (uncertain, humanHandoff, secretRefusal, secretShared, paymentStatus,
 *   aiDisabled, promptForQuestion).
 *
 * WHAT IS NOT
 *   - Approved FACTUAL content (amounts, limits, policies) is never re-typed
 *     here. It stays in the approved knowledge base and reaches a non-English
 *     customer only through the translation layer, which is validation-gated.
 *   - Operator (admin) messages are ENGLISH ONLY, by design: TELEGRAM_ADMIN_IDS
 *     is an English-speaking support desk, so the operator surface must not
 *     depend on the customer's language. Those live in OPERATOR_STRINGS.
 *
 * LANGUAGE SOURCE OF TRUTH
 *   `telegram_support_conversations.language` (one row per Telegram chat), which
 *   the database pins to TEXT NOT NULL DEFAULT 'en' with
 *   CHECK (language IN ('en', 'pt', 'ar')) - see migration 032. The column
 *   default is what an INSERT that omits the column gets, and an invalid /
 *   unsupported stored value is additionally resolved to DEFAULT_LANGUAGE ('en')
 *   here, in application code.
 *
 * ADDING A LANGUAGE LATER (es / fr / zh)
 *   1. add a locale object to CUSTOMER_STRINGS with the SAME key set,
 *   2. add it to TELEGRAM_LANGUAGES and LANGUAGE_META,
 *   3. extend the CHECK constraint in migration 032.
 *   No other restructuring is required: every consumer iterates the list and
 *   every lookup falls back to English per key.
 *
 * CONVENTIONS
 *   - pt is BRAZILIAN Portuguese (pt-BR). ar is Modern Standard Arabic.
 *   - Commands (/language, /escalate, ...) stay in ASCII inside every locale.
 */

const DEFAULT_LANGUAGE = 'en';

/** Languages the bot accepts, in keyboard order. Only these may be stored. */
const TELEGRAM_LANGUAGES = Object.freeze(['en', 'pt', 'ar']);

/**
 * Per-language metadata.
 *   native  - how the language names ITSELF (used on the inline keyboard)
 *   english - the English name (used in ENGLISH operator notifications)
 */
const LANGUAGE_META = Object.freeze({
  en: Object.freeze({ code: 'en', native: 'English', english: 'English' }),
  pt: Object.freeze({ code: 'pt', native: 'Português', english: 'Portuguese' }),
  ar: Object.freeze({ code: 'ar', native: 'العربية', english: 'Arabic' })
});

/**
 * Callback payload convention: NEVER a bare language code, so a future
 * non-language button cannot collide with a language selection.
 */
const LANG_CALLBACK_PREFIX = 'lang:';

function isSupportedLanguage(code) {
  return TELEGRAM_LANGUAGES.indexOf(String(code || '').trim().toLowerCase()) !== -1;
}

/**
 * Resolve ANY stored or requested value to a supported language.
 *
 * Accepts harmless variants ("pt-BR", " PT ", "EN") so a value written by
 * another surface (the web app stores 'pt' / 'en') still resolves, and returns
 * DEFAULT_LANGUAGE for everything else - including null, undefined, an empty
 * string, an unknown code, or a non-string. Never throws.
 */
function normalizeLanguage(raw) {
  const value = String(raw === null || raw === undefined ? '' : raw).trim().toLowerCase();
  if (!value) return DEFAULT_LANGUAGE;
  if (isSupportedLanguage(value)) return value;
  const base = value.split(/[-_]/)[0];
  return isSupportedLanguage(base) ? base : DEFAULT_LANGUAGE;
}

function languageMeta(code) {
  return LANGUAGE_META[normalizeLanguage(code)] || LANGUAGE_META[DEFAULT_LANGUAGE];
}

/** English name - for ENGLISH operator notifications. */
function languageName(code) {
  return languageMeta(code).english;
}

/** Self-name - for the inline keyboard. */
function nativeLanguageName(code) {
  return languageMeta(code).native;
}

function languageCallbackData(code) {
  return LANG_CALLBACK_PREFIX + normalizeLanguage(code);
}

/**
 * Parse a callback payload into a supported language, or null.
 *
 * Returns null for anything that is not exactly `lang:<supported>`: a wrong
 * prefix, a bare code, an unknown language, an empty string, a non-string, or
 * attacker-supplied junk. Callers must treat null as "change nothing".
 */
function parseLanguageCallback(data) {
  if (typeof data !== 'string') return null;
  const value = data.trim();
  if (value.indexOf(LANG_CALLBACK_PREFIX) !== 0) return null;
  const code = value.slice(LANG_CALLBACK_PREFIX.length).trim().toLowerCase();
  return isSupportedLanguage(code) ? code : null;
}

/**
 * Inline keyboard for /language.
 *
 * Native names, and deliberately NO flags: a flag implies a region the locale
 * does not claim (the web app's 🇸🇦/🇧🇷/🇺🇸 stand for language groups, not
 * countries), and native names are what the web app already shows.
 */
function languageKeyboard() {
  const button = (code) => ({
    text: nativeLanguageName(code),
    callback_data: languageCallbackData(code)
  });
  const rows = [];
  for (let i = 0; i < TELEGRAM_LANGUAGES.length; i += 2) {
    rows.push(TELEGRAM_LANGUAGES.slice(i, i + 2).map(button));
  }
  return { inline_keyboard: rows };
}

/**
 * Customer-facing strings. Every locale must define EVERY key: a missing key
 * would silently fall back to English, which is exactly the bug this feature
 * exists to prevent, so it is asserted by tests.
 *
 * The `en` values for the AI-layer fallbacks are kept byte-identical to
 * SupportGuidelines so an English customer sees no change at all.
 */
const CUSTOMER_STRINGS = Object.freeze({
  en: Object.freeze({
    greetingFresh: "Hi! I am the Arbitrix support assistant. How can I help you today?",
    greetingAgain: "Hi again! What can I help you with?",
    clarifyTopic: "Sorry, I may not have understood that. Are you asking about making a deposit, starting a trade, or withdrawing funds?",
    clarifyHelp: "I can help with deposits, withdrawals, trading, verification, referrals or account questions. What would you like help with?",
    thanksClose: "You're welcome! If you need anything else, just send a message here.",
    thanksOpen: "You're welcome! Just to continue where we left off:",
    ackNoQuestion: "Got it. What would you like help with?",
    anythingElse: "Is there anything else I can help you with?",
    socialAck: "Alright! 😊 Let me know if you need any further assistance.",
    socialUnderstood: "Perfect! 😊 Let me know if you need any clarification.",
    socialPositive: "Glad to hear that! 😊 Is there anything else I can help you with?",
    socialGreat: "Wonderful! 😊 Feel free to ask if you need anything else.",
    socialThanks: "You're very welcome! 😊 Happy to help.",
    socialThanksBig: "You're most welcome! 😊 We're here whenever you need assistance.",
    socialReciprocal: "Anytime! 😊 Have a great day.",
    socialClosing: "Got it. I'm here whenever you need me. 😊",
    reassure: "Yes - that is correct based on the information I have. Would you like more detail?",
    depositIntro: "I can help with that. Do you already have USDT (TRC20) in your own wallet, or would you like help buying it first?",
    depositWantHelpQuestion: "Would you like help with your first deposit?",
    depositNeedCrypto: "No problem - you can buy USDT through a supported third-party service, then send it to your Arbitrix deposit address. Availability, payment methods and fees depend on your country and the provider.",
    depositHaveCrypto: "Great. Open Deposit in the app, enter your amount, and send USDT on the TRON (TRC20) network to the exact address shown. Deposits are detected automatically once the network confirms them.",
    depositMethodPrompt: "Which method would you like a tutorial for: Paybis, Transak, or Trust Wallet?",
    depositMethodPromptAgain: "Just let me know which method you would like to use: Paybis, Transak, or Trust Wallet.",
    depositTutorialLink: "{{method}} deposit tutorial: {{url}}",
    tutorialHow: "Open the tutorial link above and follow the steps for the method you chose. If a specific step is unclear, tell me which one and I will explain it.",
    depositTutorialFollowUp: "Follow the steps in the tutorial and let me know if you run into any difficulty.",
    depositAfterAck: "Great. Once you have sent the funds, tell me \"done\" and I will guide you through the next step.",
    depositCompletedAskTransfer: "Excellent! Have you successfully transferred the funds to your Arbitrix deposit address?",
    depositTransferNo: "That is fine - take your time. I am here when you are ready. Would you like the {{method}} tutorial again?",
    depositTransferNoGeneric: "That is fine - take your time. I am here when you are ready. Would you like the deposit tutorial again?",
    depositTransferYes: "Great. Deposits are usually detected automatically once the network confirms them. Does the deposit show in your Live balance now?",
    depositCreditedQuestion: "Does the deposit show in your Live balance now?",
    depositCreditedYes: "Great. If the deposit is showing in your Live balance, you are ready to trade in Live Mode. If it is not there yet, say \"human\" and our team will check it for you.",
    depositCreditedNo: "Thanks for checking. Deposits normally confirm within a few minutes. Please keep your invoice reference and do not send the payment twice. If it still has not appeared, say \"human\" and our team will check it for you.",
    withdrawIntro: "I can help with withdrawals. You request a withdrawal to your wallet address from your Live balance, and it appears as pending in your history while it is processed.",
    withdrawTiming: "Withdrawals usually arrive within 15-30 minutes. You can follow the status in your transaction history.",
    withdrawHelpPrompt: "Would you like help with a specific withdrawal problem?",
    trustIntro: "That's a great question! 😊 It's always good to know more about a platform before getting started.",
    trustWhatWeDo: "Arbitrix is a registered business operating an automated multi-asset arbitrage platform designed to identify trading opportunities arising from price differences across supported exchanges.",
    trustExploreIntro: "Here are a few things you can explore:",
    trustPoints: "✅ Registered Business: Arbitrix has official business registration details that you can view and verify.\n✅ Try Demo Mode: Explore how the platform works using simulated funds before switching to Live Mode.\n✅ Learn How It Works: We have helpful explanations and video tutorials to guide you through the platform.\n✅ Easy Onboarding: Our support team is available to guide you through registration, deposits and platform navigation.",
    trustLinksIntro: "You can explore our official pages here:",
    trustLinks: "📄 Business Registration:\nhttps://arbitrix.pro/business-registration\n\n🎥 How Arbitrix Works:\nhttps://arbitrix.pro/how-it-works",
    trustClose: "We're happy to help you understand everything and get familiar with the platform.",
    trustSupportLine: "You can also reply \"human\" at any time and a member of our support team will take over here.",
    trustQuestion: "Would you like a quick guide on how Arbitrix works? 😊",
    trustVerify: "Our registration details are published here: https://arbitrix.pro/business-registration\n\nIt shows that Arbitrix is operated by Arbitrix Trading, registered with the Netherlands Chamber of Commerce (KVK) under KVK number 72923513. You can open the registration certificate on that page.",
    trustCertificate: "The registration certificate is on the same page - open the certificate to view it full size or download it. I can't send documents through this chat, but if you need an official copy our team can help - reply \"human\".",
    trustLimits: "I don't have more detail about that than what is published on our official pages, and I don't want to guess. If you'd like, I can ask our support team to help - reply \"human\".",
    platformIntro: "Arbitrix is an automated multi-asset arbitrage platform. It identifies price differences for the same asset across supported exchanges and automates the trades that take advantage of them.",
    platformBullets: "• Demo Mode: explore the platform with simulated funds - no deposit needed.\n• Live Mode: trade with real funds after a deposit of at least $100.\n• Automation: the bot runs the strategy for you, and you follow the results in your dashboard.",
    platformLink: "See how it works, with a walkthrough video: https://arbitrix.pro/how-it-works",
    platformQuestion: "Would you like to know how to get started?",
    earningsIntro: "Trading returns vary depending on market conditions and available arbitrage opportunities. There is no fixed daily income or guaranteed profit.",
    earningsVaries: "Arbitrix identifies opportunities across supported exchanges and automates trading, but actual results can vary. Trading involves risk - you can lose money as well as gain.",
    earningsDemo: "You can explore the platform in Demo Mode using simulated funds before deciding whether to use Live Mode.",
    earningsQuestion: "Would you like me to show you how the platform works?",
    guideOfferQuestion: "Would you like a quick guide on how Arbitrix works?",
    withdrawChecked: "Alright! 😊 If your withdrawal is showing as completed and the funds have arrived, you're all set. If it is still pending or you haven't received the funds, let me know and I'll help you check what to do next.",
    withdrawArrived: "Thanks for confirming. I'm glad the funds arrived. If anything else comes up, just send a message here.",
    withdrawStillPending: "Thanks for checking. Withdrawals usually arrive within 15-30 minutes after the request. If yours is still pending after that, I can pass it to our team - they can check it with the reference from your history.",
    btnBusiness: "📄 Business registration",
    btnHowItWorks: "🎥 How Arbitrix works",
    withdrawTutorialLink: "Arbitrix withdrawal tutorial: {{url}}",
    onboardCreateAccount: "You can create your account on the arbitrix.pro website - it takes about a minute.",
    onboardRegisteredQuestion: "Have you already created your Arbitrix account?",
    onboardRegisteredYes: "Great. Have you made your first deposit yet?",
    onboardRegisteredNo: "No problem. You can create your account on the Arbitrix website and try Demo Mode first if you like. Would you like help with your first deposit?",
    onboardDepositedQuestion: "Have you made your first deposit yet?",
    onboardDepositedYes: "Great. Does your deposit show in your Live balance now?",
    onboardDepositedNo: "No problem - I can guide you through a deposit. Do you already have USDT (TRC20), or would you like help buying it first?",
    partnerOffer: "I can also tell you about our partner programme: you earn 20% of the first qualifying deposit of each person you refer - a one-time reward, with no recurring commission. Would you like to learn more?",
    partnerHow: "Open the Referral section in your account to find your referral link and code. Share them with people who want to try Arbitrix.",
    partnerDecline: "No problem. Is there anything else I can help you with?",
    help: [
      'Arbitrix Support',
      '',
      'Send your question as a normal message and a support agent will reply here.',
      '/language - change your language',
      '/escalate - request a human agent',
      '/subscribe - partner updates in this chat',
      '/unsubscribe - stop partner updates',
        '/tutorial - open the deposit and withdrawal tutorials',
        '/progress - see where you left off in this chat',
        '/next - what to do next',
      '/chatid - show this chat ID',
      '/unlink - disconnect this chat from your Arbitrix account'
    ].join('\n'),
      tutorialMenu: 'Here are the approved tutorials. Open the one that matches how you want to fund your account:',
      progressTitle: 'In this chat so far:',
      progressWaiting: 'Waiting on:',
      progressMethod: 'Deposit method: {{method}}',
      progressEmpty: 'Nothing is in progress in this chat yet. Ask me about deposits, withdrawals, the partner programme, or ask for a human.',
      nextStepTitle: 'Your next step:',
      nextTopics: 'What would you like to do next? Tell me about deposits, withdrawals, the partner programme, or ask for a human.',
    acknowledgement: 'Thanks for contacting Arbitrix Support. Please describe your issue, and a support agent will assist you here. You can also use /language to change your language, or /escalate to request a human agent.',
    tutorialCaption: 'Prefer to watch it? Here is a short walkthrough of the deposit process.',
    escalationAck: 'Your request has been flagged for a human agent. A member of the support team will follow up in this chat.',
    textOnly: 'Please send a text message so our support team can help.',
    chatId: 'Your chat ID is: {{id}}',
    subscribeSet: 'You are subscribed to partner updates in this chat. Send /unsubscribe at any time to stop them.',
    unsubscribeSet: 'You have been unsubscribed from partner updates. Support replies in this chat are not affected.',
    subscribeUnavailable: 'Partner updates are not available right now. Your support conversation is not affected.',
    linkSuccess: 'Connected. This chat is now linked to your Arbitrix account. Use /unlink at any time to disconnect. Linking does not subscribe you to marketing messages - send /subscribe if you want partner updates.',
    linkAlready: 'This chat is already linked to your Arbitrix account. Nothing changed.',
    linkInvalid: 'That connection link is not valid or has expired. Please create a new link from your Arbitrix dashboard.',
    linkChatTaken: 'This Telegram account is already connected to a different Arbitrix account. Send /unlink to disconnect it first, then create a new link from the correct account.',
    linkAccountBusy: 'Your Arbitrix account is already connected to a different Telegram chat. Disconnect it from your dashboard first, then create a new link.',
    linkRateLimited: 'Too many connection attempts. Please wait a few minutes and try again.',
    linkUnavailable: 'Account linking is temporarily unavailable. Please try again later.',
    unlinkRemoved: 'Disconnected. This chat is no longer linked to an Arbitrix account.',
    unlinkNotLinked: 'This chat is not linked to an Arbitrix account.',
    unlinkUnavailable: 'Disconnecting is temporarily unavailable. Please try again later.',
    languagePrompt: 'Choose your language:\nYou can change it at any time with /language.',
    languageSet: "Language set to English. I'll reply in English from now on.",
    languageUnsupported: 'That language is not available yet. I will keep replying in {{language}}.',
    uncertain: 'I do not have an approved answer for that, so I do not want to guess. I have flagged this for our support team - a human can help you with it here.',
    humanHandoff: 'This is best handled by our support team, so I have passed it to a human. Please keep an eye on this chat and a member of the team will assist you.',
    secretRefusal: 'I cannot share or confirm passwords, private keys, seed phrases, or one-time codes, and Arbitrix support will never ask you for them. Never share these with anyone. If you have an account-access problem, please use "Forgot password" or ask for a human here.',
    secretShared: 'Please do not share passwords, private keys, seed phrases, or one-time codes here. For your safety I have not repeated it. If you shared a credential, change it immediately and ask for a human if you need help securing your account.',
    paymentStatus: 'I do not have access to your account or payment details, so I cannot confirm the status of a deposit or withdrawal from here. I have passed this to our support team, who can check it for you using your transaction reference.',
    aiDisabled: 'Automated answers are currently turned off. I have saved your message and a member of our support team will help you here.',
    promptForQuestion: 'Please send your question as a normal message and a support agent will assist you here.',
    storageDegraded: 'We received your message. Our support system is temporarily unavailable, so our team may take longer than usual to reply.'
  }),
  pt: Object.freeze({
    greetingFresh: "Olá! Sou o assistente de suporte da Arbitrix. Como posso ajudar você hoje?",
    greetingAgain: "Olá novamente! Como posso ajudar?",
    clarifyTopic: "Desculpe, talvez eu não tenha entendido. Você está perguntando sobre fazer um depósito, começar a operar ou sacar fundos?",
    clarifyHelp: "Posso ajudar com depósitos, saques, negociação, verificação, indicações ou dúvidas sobre a conta. Com o que você gostaria de ajuda?",
    thanksClose: "De nada! Se precisar de mais alguma coisa, basta enviar uma mensagem aqui.",
    thanksOpen: "De nada! Vamos continuar de onde paramos:",
    ackNoQuestion: "Entendi. Com o que você gostaria de ajuda?",
    anythingElse: "Posso ajudar com mais alguma coisa?",
    socialAck: "Certo! 😊 Me avise se precisar de mais alguma coisa.",
    socialUnderstood: "Perfeito! 😊 Se algo n\u00e3o ficou claro, \u00e9 s\u00f3 me perguntar.",
    socialPositive: "Que bom saber! 😊 Posso ajudar em mais alguma coisa?",
    socialGreat: "Maravilha! 😊 Fique \u00e0 vontade para perguntar se precisar de algo.",
    socialThanks: "De nada! 😊 Fico feliz em ajudar.",
    socialThanksBig: "Imagina! 😊 Estamos aqui sempre que voc\u00ea precisar.",
    socialReciprocal: "Disponha! 😊 Tenha um \u00f3timo dia.",
    socialClosing: "Combinado. Estou aqui sempre que precisar. 😊",
    reassure: "Sim - isso está correto com base nas informações que tenho. Gostaria de mais detalhes?",
    depositIntro: "Posso ajudar com isso. Você já tem USDT (TRC20) na sua própria carteira ou gostaria de ajuda para comprar primeiro?",
    depositWantHelpQuestion: "Gostaria de ajuda com o seu primeiro depósito?",
    depositNeedCrypto: "Sem problema - você pode comprar USDT por um serviço terceirizado compatível e depois enviá-lo para o seu endereço de depósito da Arbitrix. Disponibilidade, formas de pagamento e taxas dependem do seu país e do provedor.",
    depositHaveCrypto: "Ótimo. Abra a opção Depositar no aplicativo, informe o valor e envie USDT na rede TRON (TRC20) para o endereço exato mostrado. Os depósitos são detectados automaticamente assim que a rede confirma.",
    depositMethodPrompt: "Para qual método você gostaria de ver o tutorial: Paybis, Transak ou Trust Wallet?",
    depositMethodPromptAgain: "Só me diga qual método você gostaria de usar: Paybis, Transak ou Trust Wallet.",
    depositTutorialLink: "Tutorial de depósito {{method}}: {{url}}",
    tutorialHow: "Abra o link do tutorial acima e siga os passos do método que você escolheu. Se algum passo não estiver claro, diga qual é e eu explico.",
    depositTutorialFollowUp: "Siga os passos do tutorial e me avise se tiver qualquer dificuldade.",
    depositAfterAck: "Ótimo. Depois de enviar os fundos, escreva \"concluído\" e eu explico o próximo passo.",
    depositCompletedAskTransfer: "Excelente! Você conseguiu transferir os fundos para o seu endereço de depósito da Arbitrix?",
    depositTransferNo: "Tudo bem - sem pressa. Estou aqui quando você estiver pronto. Gostaria de receber o tutorial do {{method}} novamente?",
    depositTransferNoGeneric: "Sem problema - sem pressa. Estou aqui quando você estiver pronto. Quer o tutorial de depósito novamente?",
    depositTransferYes: "Ótimo. Os depósitos costumam ser detectados automaticamente assim que a rede confirma. O depósito já aparece no seu saldo Live?",
    depositCreditedQuestion: "O depósito já aparece no seu saldo Live?",
    depositCreditedYes: "Ótimo. Se o depósito já aparece no seu saldo Live, você está pronto para operar no Modo Live. Se ainda não aparecer, escreva \"humano\" e nossa equipe vai verificar para você.",
    depositCreditedNo: "Obrigado por verificar. Os depósitos normalmente são confirmados em poucos minutos. Guarde a referência da fatura e não envie o pagamento duas vezes. Se ainda não aparecer, escreva \"humano\" e nossa equipe vai verificar para você.",
    withdrawIntro: "Posso ajudar com saques. Você solicita um saque para o endereço da sua carteira a partir do saldo Live, e ele aparece como pendente no seu histórico enquanto é processado.",
    withdrawTiming: "Os saques costumam chegar em 15-30 minutos. Você pode acompanhar o status no histórico de transações.",
    withdrawHelpPrompt: "Gostaria de ajuda com algum problema específico de saque?",
    trustIntro: "Ótima pergunta! 😊 É sempre bom conhecer melhor uma plataforma antes de começar.",
    trustWhatWeDo: "A Arbitrix é uma empresa registrada que opera uma plataforma automatizada de arbitragem multi-ativos, criada para identificar oportunidades de negociação que surgem das diferenças de preço entre as corretoras suportadas.",
    trustExploreIntro: "Aqui estão algumas coisas que você pode explorar:",
    trustPoints: "✅ Empresa registrada: a Arbitrix possui dados oficiais de registro empresarial que você pode consultar e verificar.\n✅ Teste o Modo Demo: veja como a plataforma funciona com fundos simulados antes de mudar para o Modo Live.\n✅ Saiba como funciona: temos explicações e vídeos tutoriais para orientar você pela plataforma.\n✅ Onboarding fácil: nossa equipe de suporte está disponível para orientar você no cadastro, nos depósitos e na navegação da plataforma.",
    trustLinksIntro: "Você pode consultar nossas páginas oficiais aqui:",
    trustLinks: "📄 Registro empresarial:\nhttps://arbitrix.pro/business-registration\n\n🎥 Como a Arbitrix funciona:\nhttps://arbitrix.pro/how-it-works",
    trustClose: "Teremos prazer em ajudar você a entender tudo e a se familiarizar com a plataforma.",
    trustSupportLine: "Voc\u00ea tamb\u00e9m pode responder \"humano\" a qualquer momento e um membro da nossa equipe de suporte assumir\u00e1 a conversa aqui.",
    trustQuestion: "Gostaria de um guia rápido sobre como a Arbitrix funciona? 😊",
    trustVerify: "Nossos dados de registro estão publicados aqui: https://arbitrix.pro/business-registration\n\nEles mostram que a Arbitrix é operada pela Arbitrix Trading, registrada na Câmara de Comércio dos Países Baixos (KVK) sob o número 72923513. Você pode abrir o certificado de registro nessa página.",
    trustCertificate: "O certificado de registro está na mesma página - abra o certificado para vê-lo em tamanho maior ou baixá-lo. Não consigo enviar documentos por este chat, mas se você precisar de uma cópia oficial nossa equipe pode ajudar - responda \"humano\".",
    trustLimits: "Não tenho mais detalhes sobre isso além do que está publicado em nossas páginas oficiais, e não quero adivinhar. Se quiser, posso pedir ajuda à nossa equipe de suporte - responda \"humano\".",
    platformIntro: "A Arbitrix é uma plataforma automatizada de arbitragem multi-ativos. Ela identifica diferenças de preço do mesmo ativo entre as corretoras suportadas e automatiza as negociações que aproveitam essas diferenças.",
    platformBullets: "• Modo Demo: explore a plataforma com fundos simulados - sem necessidade de depósito.\n• Modo Live: negocie com dinheiro real após um depósito de pelo menos US$ 100.\n• Automação: o bot executa a estratégia por você, e você acompanha os resultados no painel.",
    platformLink: "Veja como funciona, com um vídeo explicativo: https://arbitrix.pro/how-it-works",
    platformQuestion: "Gostaria de saber como começar?",
    earningsIntro: "Os retornos de negociação variam conforme as condições de mercado e as oportunidades de arbitragem disponíveis. Não existe renda diária fixa nem lucro garantido.",
    earningsVaries: "A Arbitrix identifica oportunidades entre as corretoras suportadas e automatiza a negociação, mas os resultados reais podem variar. O trading envolve risco - você pode perder dinheiro, não apenas ganhar.",
    earningsDemo: "Você pode explorar a plataforma no Modo Demo com fundos simulados antes de decidir usar o Modo Live.",
    earningsQuestion: "Gostaria que eu mostrasse como a plataforma funciona?",
    guideOfferQuestion: "Gostaria de um guia rápido sobre como a Arbitrix funciona?",
    withdrawChecked: "Certo! 😊 Se o seu saque aparece como concluído e os fundos chegaram, está tudo certo. Se ainda estiver pendente ou você não tiver recebido os fundos, me avise e eu ajudo você a verificar o que fazer.",
    withdrawArrived: "Obrigado por confirmar. Fico feliz que os fundos tenham chegado. Se surgir qualquer outra coisa, é só enviar uma mensagem aqui.",
    withdrawStillPending: "Obrigado por verificar. Os saques geralmente chegam em 15-30 minutos após o pedido. Se o seu ainda estiver pendente depois disso, posso encaminhar à nossa equipe - eles conseguem verificar com a referência do seu histórico.",
    btnBusiness: "📄 Registro empresarial",
    btnHowItWorks: "🎥 Como a Arbitrix funciona",
    withdrawTutorialLink: "Tutorial de saque da Arbitrix: {{url}}",
    onboardCreateAccount: "Você pode criar sua conta no site arbitrix.pro - leva cerca de um minuto.",
    onboardRegisteredQuestion: "Você já criou sua conta na Arbitrix?",
    onboardRegisteredYes: "Ótimo. Você já fez o seu primeiro depósito?",
    onboardRegisteredNo: "Sem problema. Você pode criar sua conta no site da Arbitrix e experimentar o Modo Demo primeiro, se quiser. Gostaria de ajuda com o seu primeiro depósito?",
    onboardDepositedQuestion: "Você já fez o seu primeiro depósito?",
    onboardDepositedYes: "Ótimo. O depósito já aparece no seu saldo Live?",
    onboardDepositedNo: "Sem problema - posso orientar você em um depósito. Você já tem USDT (TRC20) ou gostaria de ajuda para comprar primeiro?",
    partnerOffer: "Também posso falar sobre o nosso programa de parceiros: você ganha 20% do primeiro depósito qualificado de cada pessoa que indicar - uma recompensa única, sem comissão recorrente. Gostaria de saber mais?",
    partnerHow: "Abra a seção Indicações na sua conta para encontrar seu link e código de indicação. Compartilhe com quem quiser experimentar a Arbitrix.",
    partnerDecline: "Sem problema. Posso ajudar com mais alguma coisa?",
    help: [
      'Suporte Arbitrix',
      '',
      'Envie sua pergunta como uma mensagem normal e um agente de suporte responderá aqui.',
      '/language - alterar o idioma',
      '/escalate - solicitar atendimento humano',
      '/subscribe - novidades para parceiros neste chat',
      '/unsubscribe - cancelar novidades de parceiro',
        '/tutorial - abrir os tutoriais de deposito e levantamento',
        '/progress - ver onde ficou nesta conversa',
        '/next - o que fazer a seguir',
      '/chatid - mostrar o ID desta conversa',
      '/unlink - desvincular esta conversa da sua conta Arbitrix'
    ].join('\n'),
      tutorialMenu: 'Estes sao os tutoriais aprovados. Abra o que corresponde a forma como quer financiar a sua conta:',
      progressTitle: 'Nesta conversa ate agora:',
      progressWaiting: 'A espera de:',
      progressMethod: 'Metodo de deposito: {{method}}',
      progressEmpty: 'Ainda nao ha nada em andamento nesta conversa. Pergunte-me sobre depositos, levantamentos, o programa de parceiros, ou peca um atendente humano.',
      nextStepTitle: 'O seu proximo passo:',
      nextTopics: 'O que quer fazer a seguir? Fale-me de depositos, levantamentos, do programa de parceiros, ou peca um atendente humano.',
    acknowledgement: 'Obrigado por entrar em contato com o Suporte Arbitrix. Descreva o seu problema e um agente de suporte vai ajudar você por aqui. Você também pode usar /language para alterar o idioma ou /escalate para falar com um atendente humano.',
    tutorialCaption: 'Prefere assistir? Aqui está um passo a passo curto do processo de depósito.',
    escalationAck: 'Seu pedido foi encaminhado para um atendente humano. Um membro da equipe de suporte vai responder nesta conversa.',
    textOnly: 'Por favor, envie uma mensagem de texto para que a nossa equipe de suporte possa ajudar.',
    chatId: 'O ID desta conversa é: {{id}}',
    subscribeSet: 'Você está inscrito nas novidades para parceiros neste chat. Envie /unsubscribe a qualquer momento para cancelar.',
    unsubscribeSet: 'Sua inscrição nas novidades para parceiros foi cancelada. As respostas de suporte neste chat não são afetadas.',
    subscribeUnavailable: 'As novidades para parceiros não estão disponíveis no momento. Sua conversa de suporte não é afetada.',
    linkSuccess: 'Conectado. Esta conversa agora está vinculada à sua conta Arbitrix. Use /unlink a qualquer momento para desconectar. O vínculo não inscreve você em mensagens de marketing - envie /subscribe se quiser receber novidades para parceiros.',
    linkAlready: 'Esta conversa já está vinculada à sua conta Arbitrix. Nada foi alterado.',
    linkInvalid: 'Esse link de conexão não é válido ou expirou. Crie um novo link no painel da sua conta Arbitrix.',
    linkChatTaken: 'Esta conta do Telegram já está conectada a outra conta Arbitrix. Envie /unlink para desconectá-la primeiro e depois crie um novo link na conta correta.',
    linkAccountBusy: 'Sua conta Arbitrix já está conectada a outra conversa do Telegram. Desconecte-a no painel primeiro e depois crie um novo link.',
    linkRateLimited: 'Muitas tentativas de conexão. Aguarde alguns minutos e tente novamente.',
    linkUnavailable: 'A vinculação de conta está temporariamente indisponível. Tente novamente mais tarde.',
    unlinkRemoved: 'Desconectado. Esta conversa não está mais vinculada a uma conta Arbitrix.',
    unlinkNotLinked: 'Esta conversa não está vinculada a uma conta Arbitrix.',
    unlinkUnavailable: 'A desconexão está temporariamente indisponível. Tente novamente mais tarde.',
    languagePrompt: 'Escolha o seu idioma:\nVocê pode alterar quando quiser com /language.',
    languageSet: 'Idioma definido como Português. A partir de agora, responderei em português.',
    languageUnsupported: 'Esse idioma ainda não está disponível. Vou continuar respondendo em {{language}}.',
    uncertain: 'Não tenho uma resposta aprovada para isso e não quero adivinhar. Encaminhei o seu caso para a nossa equipe de suporte — um atendente humano pode ajudar você por aqui.',
    humanHandoff: 'É melhor que a nossa equipe de suporte cuide disso, então encaminhei o seu caso para um atendente humano. Fique de olho nesta conversa e um membro da equipe vai ajudar você.',
    secretRefusal: 'Não posso compartilhar nem confirmar senhas, chaves privadas, frases de recuperação (seed) ou códigos de uso único, e o suporte da Arbitrix nunca vai pedir esses dados a você. Nunca compartilhe isso com ninguém. Se você tiver um problema de acesso à conta, use "Esqueci minha senha" ou peça ajuda a um atendente por aqui.',
    secretShared: 'Por favor, não compartilhe senhas, chaves privadas, frases de recuperação (seed) ou códigos de uso único aqui. Para a sua segurança, não repeti o conteúdo. Se você compartilhou uma credencial, altere-a imediatamente e peça ajuda a um atendente para proteger a sua conta.',
    paymentStatus: 'Não tenho acesso à sua conta nem aos detalhes do seu pagamento, então não posso confirmar por aqui o status de um depósito ou saque. Encaminhei o seu caso para a nossa equipe de suporte, que pode verificar isso usando a referência da sua transação.',
    aiDisabled: 'As respostas automáticas estão desativadas no momento. Salvei a sua mensagem e um membro da nossa equipe de suporte vai ajudar você por aqui.',
    promptForQuestion: 'Por favor, envie a sua pergunta como uma mensagem normal e um agente de suporte vai ajudar você por aqui.',
    storageDegraded: 'Recebemos a sua mensagem. Nosso sistema de suporte está temporariamente indisponível, então a nossa equipe pode demorar um pouco mais para responder.'
  }),
  ar: Object.freeze({
    greetingFresh: "مرحبًا! أنا مساعد دعم Arbitrix. كيف يمكنني مساعدتك اليوم؟",
    greetingAgain: "مرحبًا مرة أخرى! كيف يمكنني مساعدتك؟",
    clarifyTopic: "عذرًا، ربما لم أفهم ذلك. هل تسأل عن إجراء إيداع، أو بدء التداول، أو سحب الأموال؟",
    clarifyHelp: "يمكنني المساعدة في الإيداعات والسحوبات والتداول والتحقق والإحالات وأسئلة الحساب. ما الذي تريد المساعدة فيه؟",
    thanksClose: "على الرحب والسعة! إذا احتجت إلى أي شيء آخر، فما عليك سوى إرسال رسالة هنا.",
    thanksOpen: "على الرحب والسعة! لنكمل من حيث توقفنا:",
    ackNoQuestion: "حسنًا. ما الذي تريد المساعدة فيه؟",
    anythingElse: "هل يمكنني مساعدتك في أي شيء آخر؟",
    socialAck: "حسنًا! 😊 أخبرني إذا احتجت إلى أي مساعدة أخرى.",
    socialUnderstood: "ممتاز! 😊 إذا احتجت إلى أي توضيح فاسألني.",
    socialPositive: "يسعدني سماع ذلك! 😊 هل يمكنني مساعدتك في أي شيء آخر؟",
    socialGreat: "رائع! 😊 لا تتردد في السؤال إذا احتجت إلى أي شيء.",
    socialThanks: "على الرحب والسعة! 😊 يسعدني مساعدتك.",
    socialThanksBig: "على الرحب والسعة! 😊 نحن هنا كلما احتجت إلى المساعدة.",
    socialReciprocal: "بكل سرور! 😊 أتمنى لك يومًا سعيدًا.",
    socialClosing: "تمامًا. أنا هنا كلما احتجت إليّ. 😊",
    reassure: "نعم - هذا صحيح بناءً على المعلومات المتوفرة لديّ. هل تريد مزيدًا من التفاصيل؟",
    depositIntro: "يمكنني المساعدة في ذلك. هل لديك بالفعل USDT (TRC20) في محفظتك، أم تريد المساعدة في شرائه أولًا؟",
    depositWantHelpQuestion: "هل تريد المساعدة في إيداعك الأول؟",
    depositNeedCrypto: "لا مشكلة - يمكنك شراء USDT عبر خدمة طرف ثالث مدعومة، ثم إرساله إلى عنوان الإيداع الخاص بك في Arbitrix. يعتمد التوفر وطرق الدفع والرسوم على بلدك وعلى مزوّد الخدمة.",
    depositHaveCrypto: "رائع. افتح خيار الإيداع في التطبيق، وأدخل المبلغ، ثم أرسل USDT على شبكة TRON (TRC20) إلى العنوان الظاهر تمامًا. يتم اكتشاف الإيداعات تلقائيًا بعد تأكيد الشبكة.",
    depositMethodPrompt: "لأي طريقة تريد مشاهدة الدرس: Paybis أم Transak أم Trust Wallet؟",
    depositMethodPromptAgain: "أخبرني فقط بالطريقة التي تريد استخدامها: Paybis أو Transak أو Trust Wallet.",
    depositTutorialLink: "درس إيداع {{method}}: {{url}}",
    tutorialHow: "افتح رابط الدرس أعلاه واتبع الخطوات للطريقة التي اخترتها. إذا كانت خطوة معينة غير واضحة، أخبرني بأي خطوة وسأشرحها.",
    depositTutorialFollowUp: "اتبع الخطوات في الدرس وأخبرني إذا واجهت أي صعوبة.",
    depositAfterAck: "رائع. بعد إرسال الأموال، اكتب \"تم\" وسأوضح لك الخطوة التالية.",
    depositCompletedAskTransfer: "ممتاز! هل نجحت في تحويل الأموال إلى عنوان الإيداع الخاص بك في Arbitrix؟",
    depositTransferNo: "لا بأس - خذ وقتك. أنا هنا عندما تكون جاهزًا. هل تريد درس {{method}} مرة أخرى؟",
    depositTransferNoGeneric: "لا مشكلة - خذ وقتك. أنا هنا عندما تكون مستعدًا. هل تريد درس الإيداع مرة أخرى؟",
    depositTransferYes: "رائع. عادةً ما يتم اكتشاف الإيداعات تلقائيًا بعد تأكيد الشبكة. هل يظهر الإيداع في رصيد Live لديك الآن؟",
    depositCreditedQuestion: "هل يظهر الإيداع في رصيد Live لديك الآن؟",
    depositCreditedYes: "رائع. إذا كان الإيداع يظهر في رصيد Live الخاص بك، فأنت جاهز للتداول في وضع Live. وإذا لم يظهر بعد، فاكتب \"بشري\" وسيتحقق فريقنا منه.",
    depositCreditedNo: "شكرًا لتحققك. عادةً ما يتم تأكيد الإيداعات خلال بضع دقائق. احتفظ بمرجع الفاتورة ولا ترسل الدفعة مرتين. إذا لم يظهر بعد، اكتب \"موظف\" وسيتحقق فريقنا من الأمر لك.",
    withdrawIntro: "يمكنني المساعدة في السحوبات. تطلب سحبًا إلى عنوان محفظتك من رصيد Live، ويظهر كقيد الانتظار في سجلك أثناء معالجته.",
    withdrawTiming: "عادةً ما تصل السحوبات خلال 15-30 دقيقة. يمكنك متابعة الحالة في سجل المعاملات.",
    withdrawHelpPrompt: "هل تريد المساعدة في مشكلة سحب محددة؟",
    trustIntro: "سؤال رائع! 😊 من الجيد دائمًا معرفة المزيد عن أي منصة قبل البدء.",
    trustWhatWeDo: "Arbitrix شركة مسجّلة تدير منصة أتمتة للمراجحة متعددة الأصول، صُممت لتحديد فرص التداول الناشئة عن فروق الأسعار بين المنصات المدعومة.",
    trustExploreIntro: "إليك بعض الأمور التي يمكنك استكشافها:",
    trustPoints: "✅ شركة مسجّلة: لدى Arbitrix بيانات رسمية للسجل التجاري يمكنك الاطلاع عليها والتحقق منها.\n✅ جرّب الوضع التجريبي: استكشف طريقة عمل المنصة بأموال محاكاة قبل الانتقال إلى الوضع المباشر.\n✅ تعرّف على طريقة العمل: لدينا شروحات وفيديوهات تعليمية لإرشادك في المنصة.\n✅ بدء سهل: فريق الدعم لدينا مستعد لإرشادك خلال التسجيل والإيداع والتنقل في المنصة.",
    trustLinksIntro: "يمكنك الاطلاع على صفحاتنا الرسمية هنا:",
    trustLinks: "📄 السجل التجاري:\nhttps://arbitrix.pro/business-registration\n\n🎥 كيف تعمل Arbitrix:\nhttps://arbitrix.pro/how-it-works",
    trustClose: "يسعدنا مساعدتك على فهم كل شيء والتعوّد على المنصة.",
    trustSupportLine: "\u064a\u0645\u0643\u0646\u0643 \u0623\u064a\u0636\u064b\u0627 \u0627\u0644\u0631\u062f \u0628\u0643\u0644\u0645\u0629 \"\u0628\u0634\u0631\u064a\" \u0641\u064a \u0623\u064a \u0648\u0642\u062a \u0648\u0633\u064a\u062a\u0648\u0644\u0649 \u0623\u062d\u062f \u0623\u0639\u0636\u0627\u0621 \u0641\u0631\u064a\u0642 \u0627\u0644\u062f\u0639\u0645 \u0645\u062d\u0627\u062f\u062b\u062a\u0643 \u0647\u0646\u0627.",
    trustQuestion: "هل تريد دليلاً سريعًا عن طريقة عمل Arbitrix؟ 😊",
    trustVerify: "بيانات السجل التجاري منشورة هنا: https://arbitrix.pro/business-registration\n\nوتوضح أن Arbitrix تُدار بواسطة Arbitrix Trading، المسجّلة لدى غرفة التجارة الهولندية (KVK) برقم 72923513. يمكنك فتح شهادة التسجيل من تلك الصفحة.",
    trustCertificate: "شهادة التسجيل موجودة في الصفحة نفسها - افتح الشهادة لعرضها بحجم أكبر أو تنزيلها. لا أستطيع إرسال المستندات عبر هذه المحادثة، ولكن إذا كنت بحاجة إلى نسخة رسمية يمكن لفريقنا المساعدة - أرسل كلمة \"بشري\".",
    trustLimits: "ليس لديّ تفاصيل أكثر من ذلك غير ما هو منشور على صفحاتنا الرسمية، ولا أريد التخمين. إذا أردت، يمكنني أن أطلب من فريق الدعم مساعدتك - أرسل كلمة \"بشري\".",
    platformIntro: "Arbitrix منصة أتمتة للمراجحة متعددة الأصول. تحدد فروق الأسعار للأصل نفسه بين المنصات المدعومة وتنفّذ الصفقات التي تستفيد من هذه الفروق تلقائيًا.",
    platformBullets: "• الوضع التجريبي: استكشف المنصة بأموال محاكاة - دون الحاجة إلى إيداع.\n• الوضع المباشر: تداول بأموال حقيقية بعد إيداع لا يقل عن 100 دولار.\n• الأتمتة: يشغّل البوت الاستراتيجية بدلاً منك، وتتابع النتائج في لوحة التحكم.",
    platformLink: "شاهد طريقة العمل مع فيديو توضيحي: https://arbitrix.pro/how-it-works",
    platformQuestion: "هل تريد معرفة كيفية البدء؟",
    earningsIntro: "تتفاوت عوائد التداول بحسب ظروف السوق وفرص المراجحة المتاحة. لا يوجد دخل يومي ثابت ولا أرباح مضمونة.",
    earningsVaries: "تحدد Arbitrix الفرص بين المنصات المدعومة وتؤتمت التداول، لكن النتائج الفعلية قد تتفاوت. التداول ينطوي على مخاطر - يمكن أن تخسر المال وليس فقط أن تربح.",
    earningsDemo: "يمكنك استكشاف المنصة في الوضع التجريبي بأموال محاكاة قبل أن تقرر استخدام الوضع المباشر.",
    earningsQuestion: "هل تريد أن أوضح لك كيفية عمل المنصة؟",
    guideOfferQuestion: "هل تريد دليلاً سريعًا عن طريقة عمل Arbitrix؟",
    withdrawChecked: "تمام! 😊 إذا كان السحب يظهر كمكتمل ووصلت الأموال فكل شيء على ما يرام. أما إذا كان لا يزال معلّقًا أو لم تستلم الأموال، فأخبرني وسأساعدك في معرفة الخطوة التالية.",
    withdrawArrived: "شكرًا لتأكيدك. يسعدني أن الأموال وصلت. إذا احتجت أي شيء آخر، أرسل رسالة هنا.",
    withdrawStillPending: "شكرًا لتحققك. عادةً ما تصل عمليات السحب خلال 15-30 دقيقة من الطلب. إذا كان سحبك لا يزال معلّقًا بعد ذلك، يمكنني تحويل الأمر إلى فريقنا - يمكنهم التحقق منه باستخدام المرجع من سجل معاملاتك.",
    btnBusiness: "📄 السجل التجاري",
    btnHowItWorks: "🎥 كيف تعمل Arbitrix",
    withdrawTutorialLink: "درس السحب من Arbitrix: {{url}}",
    onboardCreateAccount: "يمكنك إنشاء حسابك على موقع arbitrix.pro - لا يستغرق الأمر سوى دقيقة تقريبًا.",
    onboardRegisteredQuestion: "هل أنشأت حسابك في Arbitrix بالفعل؟",
    onboardRegisteredYes: "رائع. هل أجريت إيداعك الأول بعد؟",
    onboardRegisteredNo: "لا مشكلة. يمكنك إنشاء حسابك على موقع Arbitrix وتجربة الوضع التجريبي أولًا إن أردت. هل تريد المساعدة في إيداعك الأول؟",
    onboardDepositedQuestion: "هل أجريت إيداعك الأول بعد؟",
    onboardDepositedYes: "رائع. هل يظهر إيداعك في رصيد Live لديك الآن؟",
    onboardDepositedNo: "لا مشكلة - يمكنني إرشادك خلال الإيداع. هل لديك USDT (TRC20) بالفعل، أم تريد المساعدة في شرائه أولًا؟",
    partnerOffer: "يمكنني أيضًا إخبارك ببرنامج الشركاء لدينا: تكسب 20% من أول إيداع مؤهل لكل شخص تحيله - مكافأة لمرة واحدة، دون عمولة متكررة. هل تريد معرفة المزيد؟",
    partnerHow: "افتح قسم الإحالات في حسابك للعثور على رابط الإحالة والرمز الخاص بك. شاركهما مع من يريد تجربة Arbitrix.",
    partnerDecline: "لا مشكلة. هل يمكنني مساعدتك في أي شيء آخر؟",
    help: [
      'دعم Arbitrix',
      '',
      'أرسل سؤالك كرسالة عادية وسيرد عليك أحد موظفي الدعم هنا.',
      '/language - تغيير اللغة',
      '/escalate - طلب موظف دعم بشري',
      '/subscribe - تحديثات الشركاء في هذه المحادثة',
      '/unsubscribe - إلغاء تحديثات الشركاء',
        '/tutorial - فتح دروس الإيداع والسحب',
        '/progress - معرفة أين توقفت في هذه المحادثة',
        '/next - ما الذي تفعله بعد ذلك',
      '/chatid - عرض معرّف هذه المحادثة',
      '/unlink - إلغاء ربط هذه المحادثة بحسابك في Arbitrix'
    ].join('\n'),
      tutorialMenu: 'هذه هي الدروس المعتمدة. افتح الدرس الذي يناسب طريقة تمويل حسابك:',
      progressTitle: 'في هذه المحادثة حتى الآن:',
      progressWaiting: 'بانتظار:',
      progressMethod: 'طريقة الإيداع: {{method}}',
      progressEmpty: 'لا يوجد شيء قيد التنفيذ في هذه المحادثة بعد. اسألني عن الإيداع أو السحب أو برنامج الشركاء، أو اطلب موظف دعم بشري.',
      nextStepTitle: 'خطوتك التالية:',
      nextTopics: 'ماذا تريد أن تفعل بعد ذلك؟ أخبرني عن الإيداع أو السحب أو برنامج الشركاء، أو اطلب موظف دعم بشري.',
    acknowledgement: 'شكرًا لتواصلك مع دعم Arbitrix. يُرجى وصف مشكلتك، وسيساعدك أحد موظفي الدعم هنا. يمكنك أيضًا استخدام /language لتغيير اللغة، أو /escalate لطلب التحدث مع موظف دعم بشري.',
    tutorialCaption: 'هل تفضّل المشاهدة؟ إليك شرحًا قصيرًا لعملية الإيداع.',
    escalationAck: 'تم تحويل طلبك إلى موظف دعم بشري. سيتابع معك أحد أعضاء فريق الدعم في هذه المحادثة.',
    textOnly: 'يُرجى إرسال رسالة نصية حتى يتمكن فريق الدعم من مساعدتك.',
    chatId: 'معرّف هذه المحادثة هو: {{id}}',
    subscribeSet: 'تم تسجيلك لتلقي تحديثات الشركاء في هذه المحادثة. أرسل /unsubscribe في أي وقت لإلغائها.',
    unsubscribeSet: 'تم إلغاء اشتراكك في تحديثات الشركاء. ردود الدعم في هذه المحادثة غير متأثرة.',
    subscribeUnavailable: 'تحديثات الشركاء غير متاحة الآن. محادثة الدعم الخاصة بك غير متأثرة.',
    linkSuccess: 'تم الارتباط. أصبحت هذه المحادثة مرتبطة بحسابك في Arbitrix. استخدم /unlink في أي وقت لإلغاء الربط. الربط لا يشتركك في رسائل التسويق - أرسل /subscribe إذا كنت تريد تحديثات الشركاء.',
    linkAlready: 'هذه المحادثة مرتبطة بالفعل بحسابك في Arbitrix. لم يتغير شيء.',
    linkInvalid: 'رابط الارتباط غير صالح أو انتهت صلاحيته. يرجى إنشاء رابط جديد من لوحة حسابك في Arbitrix.',
    linkChatTaken: 'حساب تيليجرام هذا مرتبط بالفعل بحساب Arbitrix آخر. أرسل /unlink لفصله أولاً، ثم أنشئ رابطاً جديداً من الحساب الصحيح.',
    linkAccountBusy: 'حسابك في Arbitrix مرتبط بالفعل بمحادثة تيليجرام أخرى. افصل الربط من لوحة التحكم أولاً، ثم أنشئ رابطاً جديداً.',
    linkRateLimited: 'محاولات ارتباط كثيرة. يرجى الانتظار بضع دقائق والمحاولة مجدداً.',
    linkUnavailable: 'ربط الحساب غير متاح مؤقتاً. يرجى المحاولة لاحقاً.',
    unlinkRemoved: 'تم فصل الربط. لم تعد هذه المحادثة مرتبطة بحساب Arbitrix.',
    unlinkNotLinked: 'هذه المحادثة غير مرتبطة بحساب Arbitrix.',
    unlinkUnavailable: 'فصل الربط غير متاح مؤقتاً. يرجى المحاولة لاحقاً.',
    languagePrompt: 'اختر لغتك:\nيمكنك تغييرها في أي وقت بالأمر /language.',
    languageSet: 'تم تعيين اللغة إلى العربية. سأرد عليك بالعربية من الآن.',
    languageUnsupported: 'هذه اللغة غير متاحة بعد. سأستمر في الرد بـ{{language}}.',
    uncertain: 'لا توجد لديّ إجابة معتمدة على ذلك، ولا أرغب في التخمين. لقد أحلت الأمر إلى فريق الدعم لدينا، ويمكن لأحد الموظفين مساعدتك هنا.',
    humanHandoff: 'من الأفضل أن يتولى فريق الدعم لدينا هذه المسألة، وقد أحلت الأمر إلى موظف بشري. تابع هذه المحادثة وسيساعدك أحد أعضاء الفريق.',
    secretRefusal: 'لا يمكنني مشاركة أو تأكيد كلمات المرور أو المفاتيح الخاصة أو عبارات الاسترداد (seed) أو الرموز لمرة واحدة، ولن يطلب منك دعم Arbitrix هذه البيانات أبدًا. لا تشاركها مع أي شخص. إذا كنت تواجه مشكلة في الوصول إلى حسابك، فاستخدم "نسيت كلمة المرور" أو اطلب المساعدة من موظف هنا.',
    secretShared: 'يُرجى عدم مشاركة كلمات المرور أو المفاتيح الخاصة أو عبارات الاسترداد (seed) أو الرموز لمرة واحدة هنا. من أجل سلامتك لم أُعِد كتابة ما أرسلته. إذا شاركت بيانات دخول، فغيّرها فورًا واطلب المساعدة من موظف لتأمين حسابك.',
    paymentStatus: 'ليس لديّ صلاحية الوصول إلى حسابك أو تفاصيل عملية الدفع، لذا لا يمكنني تأكيد حالة الإيداع أو السحب من هنا. لقد أحلت الأمر إلى فريق الدعم لدينا، ويمكنهم التحقق منه باستخدام رقم مرجع العملية.',
    aiDisabled: 'الردود الآلية متوقفة حاليًا. لقد حفظت رسالتك وسيساعدك أحد أعضاء فريق الدعم هنا.',
    promptForQuestion: 'يُرجى إرسال سؤالك كرسالة عادية وسيساعدك أحد موظفي الدعم هنا.',
    storageDegraded: 'لقد استلمنا رسالتك. نظام الدعم لدينا غير متاح مؤقتًا، لذلك قد يتأخر رد فريقنا أكثر من المعتاد.'
  })
});

/**
 * OPERATOR strings - ENGLISH ONLY, by design.
 *
 * These are never customer-facing, so they are not localized. Keeping them in a
 * separate object makes that guarantee explicit and testable (a customer-facing
 * lookup can never accidentally reach them).
 */
const OPERATOR_STRINGS = Object.freeze({
  notifyTitle: '🔔 New Customer Message',
  notifyLanguage: '🌐 Language: {{language}}',
  notifyOriginal: 'Original message ({{language}}):',
  notifyMessage: 'Message:',
  notifyTranslation: 'English translation:',
  notifyNoTranslation: 'English translation: unavailable - the original message is shown above.',
  // Bot-response status shown on a private-admin notification, so an operator can
  // tell at a glance whether the bot already answered or a human is needed.
  // These describe what ACTUALLY happened (a Telegram send that succeeded, a
  // stored human reply) - the service decides them, never the AI's intent.
  notifyStatusBotReplied: '🤖 BOT REPLIED',
  notifyStatusBotRepliedDetail: 'The customer has already received an automatic response.',
  notifyStatusHumanNeeded: '⚠️ HUMAN NEEDED',
  notifyStatusHumanNeededDetail: 'The bot could not provide a confident answer.',
  notifyStatusHumanRequested: '👨‍💼 HUMAN REQUESTED',
  notifyStatusHumanRequestedDetail: 'Please respond to the customer.',
  notifyStatusHumanConversation: '💬 HUMAN CONVERSATION',
  notifyStatusHumanConversationDetail: 'A human is already handling this conversation.',
  notifyCustomerAnswer: 'Customer answer:',
  translateUnavailableToAdmin: 'Sent in English: automatic translation into {{language}} is unavailable, so the customer received your original English text.',
  translateBlockedToAdmin: 'Your reply was sent in English: the {{language}} translation was withheld by the safety check ({{reason}}). Please review before sending again.',
  translateUnavailableNote: 'Automatic translation is unavailable right now.'
});

function interpolate(text, vars) {
  if (!vars) return text;
  return Object.keys(vars).reduce(
    (acc, key) => acc.split('{{' + key + '}}').join(String(vars[key])),
    text
  );
}

/**
 * Look up a CUSTOMER-facing string. Unknown locales and unknown keys fall back
 * to English (per key), and an unknown key with no English entry returns the
 * key itself so a failure is visible rather than silent.
 */
function t(language, key, vars) {
  const table = CUSTOMER_STRINGS[normalizeLanguage(language)] || {};
  const fallback = CUSTOMER_STRINGS[DEFAULT_LANGUAGE];
  const text = table[key] !== undefined ? table[key] : fallback[key];
  if (text === undefined) return key;
  return interpolate(text, vars);
}

/** Look up an OPERATOR string (English only, interpolated). */
function tOperator(key, vars) {
  const text = OPERATOR_STRINGS[key];
  if (text === undefined) return key;
  return interpolate(text, vars);
}

module.exports = {
  DEFAULT_LANGUAGE,
  TELEGRAM_LANGUAGES,
  LANGUAGE_META,
  LANG_CALLBACK_PREFIX,
  CUSTOMER_STRINGS,
  OPERATOR_STRINGS,
  isSupportedLanguage,
  normalizeLanguage,
  languageMeta,
  languageName,
  nativeLanguageName,
  languageCallbackData,
  parseLanguageCallback,
  languageKeyboard,
  t,
  tOperator
};
