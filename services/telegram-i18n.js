'use strict';

/**
 * Telegram-specific localization for the Kalderix support bot
 * (en / es / pt / fr / ar / zh - the same six languages the web app offers).
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
 *   CHECK (language IN ('en', 'es', 'pt', 'fr', 'ar', 'zh')) - migration 032
 *   established the column and migration 060 widened the vocabulary. The column
 *   default is what an INSERT that omits the column gets, and an invalid /
 *   unsupported stored value is additionally resolved to DEFAULT_LANGUAGE ('en')
 *   here, in application code, so a value written by an older build (or by hand)
 *   can never break a reply.
 *
 * ADDING A LANGUAGE LATER
 *   1. add a locale object to CUSTOMER_STRINGS with the SAME key set,
 *   2. add it to TELEGRAM_LANGUAGES and LANGUAGE_META here AND to
 *      SupportTranslator.TRANSLATABLE_LANGUAGES + SupportGuidelines.LANGUAGE_NAMES
 *      (the AI/translation layer), and give it a script check if its script is
 *      unambiguous,
 *   3. extend the CHECK constraint in a new migration.
 *   No other restructuring is required: every consumer iterates the list and
 *   every lookup falls back to English per key.
 *
 * CONVENTIONS
 *   - pt is BRAZILIAN Portuguese (pt-BR). ar is Modern Standard Arabic.
 *     zh is SIMPLIFIED Chinese.
 *   - Non-ASCII characters are written as \u escapes so this file stays ASCII.
 *   - Commands (/language, /escalate, ...) stay in ASCII inside every locale.
 */

const DEFAULT_LANGUAGE = 'en';

/** Languages the bot accepts, in keyboard order. Only these may be stored. */
const TELEGRAM_LANGUAGES = Object.freeze(['en', 'es', 'pt', 'fr', 'ar', 'zh']);

/**
 * Per-language metadata.
 *   native  - how the language names ITSELF (used on the inline keyboard)
 *   english - the English name (used in ENGLISH operator notifications)
 */
const LANGUAGE_META = Object.freeze({
  en: Object.freeze({ code: 'en', native: 'English', english: 'English' }),
  es: Object.freeze({ code: 'es', native: 'Espa\u00f1ol', english: 'Spanish' }),
  pt: Object.freeze({ code: 'pt', native: 'Português', english: 'Portuguese' }),
  fr: Object.freeze({ code: 'fr', native: 'Fran\u00e7ais', english: 'French' }),
  ar: Object.freeze({ code: 'ar', native: 'العربية', english: 'Arabic' }),
  zh: Object.freeze({ code: 'zh', native: '\u7b80\u4f53\u4e2d\u6587', english: 'Simplified Chinese' })
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
    greetingFresh: "Hi! I am the Kalderix support assistant. How can I help you today?",
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
    depositNeedCrypto: "No problem - you can buy USDT through a supported third-party service, then send it to your Kalderix deposit address. Availability, payment methods and fees depend on your country and the provider.",
    depositHaveCrypto: "Great. Open Deposit in the app, enter your amount, and send USDT on the TRON (TRC20) network to the exact address shown. Deposits are detected automatically once the network confirms them.",
    depositMethodPrompt: "Which method would you like a tutorial for: Paybis, Transak, or Trust Wallet?",
    depositMethodPromptAgain: "Just let me know which method you would like to use: Paybis, Transak, or Trust Wallet.",
    depositTutorialLink: "{{method}} deposit tutorial: {{url}}",
    tutorialHow: "Open the tutorial link above and follow the steps for the method you chose. If a specific step is unclear, tell me which one and I will explain it.",
    depositTutorialFollowUp: "Follow the steps in the tutorial and let me know if you run into any difficulty.",
    depositAfterAck: "Great. Once you have sent the funds, tell me \"done\" and I will guide you through the next step.",
    depositCompletedAskTransfer: "Excellent! Have you successfully transferred the funds to your Kalderix deposit address?",
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
    trustWhatWeDo: "Kalderix is a registered business operating an automated multi-asset arbitrage platform designed to identify trading opportunities arising from price differences across supported exchanges.",
    trustExploreIntro: "Here are a few things you can explore:",
    trustPoints: "✅ Registered Business: Kalderix has official business registration details that you can view and verify.\n✅ Try Demo Mode: Explore how the platform works using simulated funds before switching to Live Mode.\n✅ Learn How It Works: We have helpful explanations and video tutorials to guide you through the platform.\n✅ Easy Onboarding: Our support team is available to guide you through registration, deposits and platform navigation.",
    trustLinksIntro: "You can explore our official pages here:",
    trustLinks: "📄 Business Registration:\nhttps://arbitrix.pro/business-registration\n\n🎥 How Kalderix Works:\nhttps://arbitrix.pro/how-it-works",
    trustClose: "We're happy to help you understand everything and get familiar with the platform.",
    trustSupportLine: "You can also reply \"human\" at any time and a member of our support team will take over here.",
    trustQuestion: "Would you like a quick guide on how Kalderix works? 😊",
    trustVerify: "Our registration details are published here: https://arbitrix.pro/business-registration\n\nIt shows that Kalderix is operated by Arbitrix Trading, registered with the Netherlands Chamber of Commerce (KVK) under KVK number 72923513. You can open the registration certificate on that page.",
    trustCertificate: "The registration certificate is on the same page - open the certificate to view it full size or download it. I can't send documents through this chat, but if you need an official copy our team can help - reply \"human\".",
    trustLimits: "I don't have more detail about that than what is published on our official pages, and I don't want to guess. If you'd like, I can ask our support team to help - reply \"human\".",
    platformIntro: "Kalderix is an automated multi-asset arbitrage platform. It identifies price differences for the same asset across supported exchanges and automates the trades that take advantage of them.",
    platformBullets: "• Demo Mode: explore the platform with simulated funds - no deposit needed.\n• Live Mode: trade with real funds after a deposit of at least $50.\n• Automation: the bot runs the strategy for you, and you follow the results in your dashboard.",
    platformLink: "See how it works, with a walkthrough video: https://arbitrix.pro/how-it-works",
    platformQuestion: "Would you like to know how to get started?",
    earningsIntro: "Trading returns vary depending on market conditions and available arbitrage opportunities. There is no fixed daily income or guaranteed profit.",
    earningsVaries: "Kalderix identifies opportunities across supported exchanges and automates trading, but actual results can vary. Trading involves risk - you can lose money as well as gain.",
    earningsDemo: "You can explore the platform in Demo Mode using simulated funds before deciding whether to use Live Mode.",
    earningsQuestion: "Would you like me to show you how the platform works?",
    guideOfferQuestion: "Would you like a quick guide on how Kalderix works?",
    withdrawChecked: "Alright! 😊 If your withdrawal is showing as completed and the funds have arrived, you're all set. If it is still pending or you haven't received the funds, let me know and I'll help you check what to do next.",
    withdrawArrived: "Thanks for confirming. I'm glad the funds arrived. If anything else comes up, just send a message here.",
    withdrawStillPending: "Thanks for checking. Withdrawals usually arrive within 15-30 minutes after the request. If yours is still pending after that, I can pass it to our team - they can check it with the reference from your history.",
    btnBusiness: "📄 Business registration",
    btnHowItWorks: "🎥 How Kalderix works",
    withdrawTutorialLink: "Kalderix withdrawal tutorial: {{url}}",
    onboardCreateAccount: "You can create your account on the arbitrix.pro website - it takes about a minute.",
    onboardRegisteredQuestion: "Have you already created your Kalderix account?",
    onboardRegisteredYes: "Great. Have you made your first deposit yet?",
    onboardRegisteredNo: "No problem. You can create your account on the Kalderix website and try Demo Mode first if you like. Would you like help with your first deposit?",
    onboardDepositedQuestion: "Have you made your first deposit yet?",
    onboardDepositedYes: "Great. Does your deposit show in your Live balance now?",
    onboardDepositedNo: "No problem - I can guide you through a deposit. Do you already have USDT (TRC20), or would you like help buying it first?",
    partnerOffer: "I can also tell you about our partner programme: you earn 20% of the first qualifying deposit of each person you refer - a one-time reward, with no recurring commission. Would you like to learn more?",
    partnerHow: "Open the Referral section in your account to find your referral link and code. Share them with people who want to try Kalderix.",
    partnerDecline: "No problem. Is there anything else I can help you with?",
    help: [
      'Kalderix Support',
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
      '/unlink - disconnect this chat from your Kalderix account'
    ].join('\n'),
      tutorialMenu: 'Here are the approved tutorials. Open the one that matches how you want to fund your account:',
      progressTitle: 'In this chat so far:',
      progressWaiting: 'Waiting on:',
      progressMethod: 'Deposit method: {{method}}',
      progressEmpty: 'Nothing is in progress in this chat yet. Ask me about deposits, withdrawals, the partner programme, or ask for a human.',
      nextStepTitle: 'Your next step:',
      nextTopics: 'What would you like to do next? Tell me about deposits, withdrawals, the partner programme, or ask for a human.',
    acknowledgement: 'Thanks for contacting Kalderix Support. Please describe your issue, and a support agent will assist you here. You can also use /language to change your language, or /escalate to request a human agent.',
    tutorialCaption: 'Prefer to watch it? Here is a short walkthrough of the deposit process.',
    escalationAck: 'Your request has been flagged for a human agent. A member of the support team will follow up in this chat.',
    textOnly: 'Please send a text message so our support team can help.',
    chatId: 'Your chat ID is: {{id}}',
    subscribeSet: 'You are subscribed to partner updates in this chat. Send /unsubscribe at any time to stop them.',
    unsubscribeSet: 'You have been unsubscribed from partner updates. Support replies in this chat are not affected.',
    subscribeUnavailable: 'Partner updates are not available right now. Your support conversation is not affected.',
    linkSuccess: 'Connected. This chat is now linked to your Kalderix account. Use /unlink at any time to disconnect. Linking does not subscribe you to marketing messages - send /subscribe if you want partner updates.',
    linkAlready: 'This chat is already linked to your Kalderix account. Nothing changed.',
    linkInvalid: 'That connection link is not valid or has expired. Please create a new link from your Kalderix dashboard.',
    linkChatTaken: 'This Telegram account is already connected to a different Kalderix account. Send /unlink to disconnect it first, then create a new link from the correct account.',
    linkAccountBusy: 'Your Kalderix account is already connected to a different Telegram chat. Disconnect it from your dashboard first, then create a new link.',
    linkRateLimited: 'Too many connection attempts. Please wait a few minutes and try again.',
    linkUnavailable: 'Account linking is temporarily unavailable. Please try again later.',
    unlinkRemoved: 'Disconnected. This chat is no longer linked to a Kalderix account.',
    unlinkNotLinked: 'This chat is not linked to a Kalderix account.',
    unlinkUnavailable: 'Disconnecting is temporarily unavailable. Please try again later.',
    languagePrompt: 'Choose your language:\nYou can change it at any time with /language.',
    languageSet: "Language set to English. I'll reply in English from now on.",
    languageUnsupported: 'That language is not available yet. I will keep replying in {{language}}.',
    uncertain: 'I do not have an approved answer for that, so I do not want to guess. I have flagged this for our support team - a human can help you with it here.',
    humanHandoff: 'This is best handled by our support team, so I have passed it to a human. Please keep an eye on this chat and a member of the team will assist you.',
    secretRefusal: 'I cannot share or confirm passwords, private keys, seed phrases, or one-time codes, and Kalderix support will never ask you for them. Never share these with anyone. If you have an account-access problem, please use "Forgot password" or ask for a human here.',
    secretShared: 'Please do not share passwords, private keys, seed phrases, or one-time codes here. For your safety I have not repeated it. If you shared a credential, change it immediately and ask for a human if you need help securing your account.',
    paymentStatus: 'I do not have access to your account or payment details, so I cannot confirm the status of a deposit or withdrawal from here. I have passed this to our support team, who can check it for you using your transaction reference.',
    aiDisabled: 'Automated answers are currently turned off. I have saved your message and a member of our support team will help you here.',
    promptForQuestion: 'Please send your question as a normal message and a support agent will assist you here.',
    storageDegraded: 'We received your message. Our support system is temporarily unavailable, so our team may take longer than usual to reply.'
  }),
    es: Object.freeze({
    greetingFresh: '\u00a1Hola! Soy el asistente de soporte de Kalderix. \u00bfC\u00f3mo puedo ayudarte hoy?',
    greetingAgain: '\u00a1Hola de nuevo! \u00bfEn qu\u00e9 puedo ayudarte?',
    clarifyTopic: 'Lo siento, puede que no te haya entendido. \u00bfPreguntas por hacer un dep\u00f3sito, empezar a operar o retirar fondos?',
    clarifyHelp: 'Puedo ayudarte con dep\u00f3sitos, retiros, trading, verificaci\u00f3n, referidos o dudas sobre la cuenta. \u00bfCon qu\u00e9 te gustar\u00eda que te ayudara?',
    thanksClose: '\u00a1De nada! Si necesitas algo m\u00e1s, solo env\u00eda un mensaje aqu\u00ed.',
    thanksOpen: '\u00a1De nada! Para continuar donde lo dejamos:',
    ackNoQuestion: 'Entendido. \u00bfCon qu\u00e9 te gustar\u00eda que te ayudara?',
    anythingElse: '\u00bfHay algo m\u00e1s en lo que pueda ayudarte?',
    socialAck: '\u00a1Muy bien! \ud83d\ude0a Av\u00edsame si necesitas m\u00e1s ayuda.',
    socialUnderstood: '\u00a1Perfecto! \ud83d\ude0a Av\u00edsame si necesitas alguna aclaraci\u00f3n.',
    socialPositive: '\u00a1Me alegra saberlo! \ud83d\ude0a \u00bfHay algo m\u00e1s en lo que pueda ayudarte?',
    socialGreat: '\u00a1Excelente! \ud83d\ude0a Pregunta sin problema si necesitas algo m\u00e1s.',
    socialThanks: '\u00a1De nada! \ud83d\ude0a Encantado de ayudar.',
    socialThanksBig: '\u00a1Con mucho gusto! \ud83d\ude0a Estamos aqu\u00ed siempre que necesites ayuda.',
    socialReciprocal: '\u00a1Cuando quieras! \ud83d\ude0a Que tengas un buen d\u00eda.',
    socialClosing: 'Entendido. Estoy aqu\u00ed cuando me necesites. \ud83d\ude0a',
    reassure: 'S\u00ed, es correcto seg\u00fan la informaci\u00f3n que tengo. \u00bfQuieres m\u00e1s detalles?',
    depositIntro: 'Puedo ayudarte con eso. \u00bfYa tienes USDT (TRC20) en tu propia cartera o quieres ayuda para comprarlo primero?',
    depositWantHelpQuestion: '\u00bfQuieres ayuda con tu primer dep\u00f3sito?',
    depositNeedCrypto: 'No hay problema: puedes comprar USDT a trav\u00e9s de un servicio externo compatible y luego enviarlo a tu direcci\u00f3n de dep\u00f3sito de Kalderix. La disponibilidad, los m\u00e9todos de pago y las comisiones dependen de tu pa\u00eds y del proveedor.',
    depositHaveCrypto: 'Genial. Abre Depositar en la app, introduce tu importe y env\u00eda USDT en la red TRON (TRC20) a la direcci\u00f3n exacta que se muestra. Los dep\u00f3sitos se detectan autom\u00e1ticamente cuando la red los confirma.',
    depositMethodPrompt: '\u00bfPara qu\u00e9 m\u00e9todo quieres el tutorial: Paybis, Transak o Trust Wallet?',
    depositMethodPromptAgain: 'Solo dime qu\u00e9 m\u00e9todo quieres usar: Paybis, Transak o Trust Wallet.',
    depositTutorialLink: 'Tutorial de dep\u00f3sito con {{method}}: {{url}}',
    tutorialHow: 'Abre el enlace del tutorial de arriba y sigue los pasos del m\u00e9todo que elegiste. Si alg\u00fan paso no est\u00e1 claro, dime cu\u00e1l y te lo explico.',
    depositTutorialFollowUp: 'Sigue los pasos del tutorial y av\u00edsame si tienes alguna dificultad.',
    depositAfterAck: 'Genial. Cuando hayas enviado los fondos, escribe \u00ablisto\u00bb y te indicar\u00e9 el siguiente paso.',
    depositCompletedAskTransfer: '\u00a1Excelente! \u00bfHas transferido correctamente los fondos a tu direcci\u00f3n de dep\u00f3sito de Kalderix?',
    depositTransferNo: 'No pasa nada, t\u00f3mate tu tiempo. Aqu\u00ed estoy cuando est\u00e9s listo. \u00bfQuieres ver de nuevo el tutorial de {{method}}?',
    depositTransferNoGeneric: 'No pasa nada, t\u00f3mate tu tiempo. Aqu\u00ed estoy cuando est\u00e9s listo. \u00bfQuieres ver de nuevo el tutorial de dep\u00f3sito?',
    depositTransferYes: 'Genial. Los dep\u00f3sitos suelen detectarse autom\u00e1ticamente cuando la red los confirma. \u00bfYa aparece el dep\u00f3sito en tu saldo Live?',
    depositCreditedQuestion: '\u00bfYa aparece el dep\u00f3sito en tu saldo Live?',
    depositCreditedYes: 'Genial. Si el dep\u00f3sito aparece en tu saldo Live, ya puedes operar en el Modo Live. Si todav\u00eda no aparece, escribe \u00abhumano\u00bb y nuestro equipo lo revisar\u00e1 por ti.',
    depositCreditedNo: 'Gracias por comprobarlo. Los dep\u00f3sitos suelen confirmarse en pocos minutos. Guarda la referencia de tu factura y no env\u00edes el pago dos veces. Si sigue sin aparecer, escribe \u00abhumano\u00bb y nuestro equipo lo revisar\u00e1 por ti.',
    withdrawIntro: 'Puedo ayudarte con los retiros. Solicitas un retiro a la direcci\u00f3n de tu cartera desde tu saldo Live, y aparece como pendiente en tu historial mientras se procesa.',
    withdrawTiming: 'Los retiros suelen llegar en 15-30 minutos. Puedes seguir el estado en tu historial de transacciones.',
    withdrawHelpPrompt: '\u00bfQuieres ayuda con alg\u00fan problema concreto de retiro?',
    trustIntro: '\u00a1Buena pregunta! \ud83d\ude0a Siempre es \u00fatil conocer mejor una plataforma antes de empezar.',
    trustWhatWeDo: 'Kalderix es una empresa registrada que opera una plataforma automatizada de arbitraje multiactivo, dise\u00f1ada para identificar oportunidades de trading que surgen de las diferencias de precio entre los exchanges compatibles.',
    trustExploreIntro: 'Estas son algunas cosas que puedes explorar:',
    trustPoints: '\u2705 Empresa registrada: Kalderix tiene datos oficiales de registro mercantil que puedes consultar y verificar.\n\u2705 Prueba el Modo Demo: explora c\u00f3mo funciona la plataforma con fondos simulados antes de pasar al Modo Live.\n\u2705 Descubre c\u00f3mo funciona: tenemos explicaciones y v\u00eddeos tutoriales para guiarte por la plataforma.\n\u2705 Incorporaci\u00f3n sencilla: nuestro equipo de soporte est\u00e1 disponible para guiarte en el registro, los dep\u00f3sitos y el uso de la plataforma.',
    trustLinksIntro: 'Puedes consultar nuestras p\u00e1ginas oficiales aqu\u00ed:',
    trustLinks: '\ud83d\udcc4 Registro mercantil:\nhttps://arbitrix.pro/business-registration\n\n\ud83c\udfa5 C\u00f3mo funciona Kalderix:\nhttps://arbitrix.pro/how-it-works',
    trustClose: 'Nos encanta ayudarte a entenderlo todo y a familiarizarte con la plataforma.',
    trustSupportLine: 'Tambi\u00e9n puedes escribir \u00abhumano\u00bb en cualquier momento y un miembro de nuestro equipo de soporte se har\u00e1 cargo aqu\u00ed.',
    trustQuestion: '\u00bfQuieres una gu\u00eda r\u00e1pida sobre c\u00f3mo funciona Kalderix? \ud83d\ude0a',
    trustVerify: 'Nuestros datos de registro est\u00e1n publicados aqu\u00ed: https://arbitrix.pro/business-registration\n\nMuestran que Kalderix est\u00e1 operada por Arbitrix Trading, registrada en la C\u00e1mara de Comercio de los Pa\u00edses Bajos (KVK) con el n\u00famero de KVK 72923513. Puedes abrir el certificado de registro en esa p\u00e1gina.',
    trustCertificate: 'El certificado de registro est\u00e1 en la misma p\u00e1gina: \u00e1brelo para verlo a tama\u00f1o completo o descargarlo. No puedo enviar documentos por este chat, pero si necesitas una copia oficial nuestro equipo puede ayudarte: escribe \u00abhumano\u00bb.',
    trustLimits: 'No tengo m\u00e1s detalles que los publicados en nuestras p\u00e1ginas oficiales y no quiero adivinar. Si quieres, puedo pedir ayuda a nuestro equipo de soporte: escribe \u00abhumano\u00bb.',
    platformIntro: 'Kalderix es una plataforma automatizada de arbitraje multiactivo. Identifica diferencias de precio del mismo activo entre los exchanges compatibles y automatiza las operaciones que las aprovechan.',
    platformBullets: '\u2022 Modo Demo: explora la plataforma con fondos simulados, sin necesidad de dep\u00f3sito.\n\u2022 Modo Live: opera con fondos reales tras un dep\u00f3sito de al menos $50.\n\u2022 Automatizaci\u00f3n: el bot ejecuta la estrategia por ti y sigues los resultados en tu panel.',
    platformLink: 'Mira c\u00f3mo funciona, con un v\u00eddeo explicativo: https://arbitrix.pro/how-it-works',
    platformQuestion: '\u00bfQuieres saber c\u00f3mo empezar?',
    earningsIntro: 'Los rendimientos del trading var\u00edan seg\u00fan las condiciones del mercado y las oportunidades de arbitraje disponibles. No hay ingresos diarios fijos ni beneficios garantizados.',
    earningsVaries: 'Kalderix identifica oportunidades entre los exchanges compatibles y automatiza el trading, pero los resultados reales pueden variar. El trading conlleva riesgo: puedes perder dinero, no solo ganarlo.',
    earningsDemo: 'Puedes explorar la plataforma en el Modo Demo con fondos simulados antes de decidir si usas el Modo Live.',
    earningsQuestion: '\u00bfQuieres que te muestre c\u00f3mo funciona la plataforma?',
    guideOfferQuestion: '\u00bfQuieres una gu\u00eda r\u00e1pida sobre c\u00f3mo funciona Kalderix?',
    withdrawChecked: '\u00a1Muy bien! \ud83d\ude0a Si tu retiro aparece como completado y los fondos han llegado, todo est\u00e1 en orden. Si sigue pendiente o no has recibido los fondos, av\u00edsame y te ayudo a revisar los siguientes pasos.',
    withdrawArrived: 'Gracias por confirmarlo. Me alegra que los fondos hayan llegado. Si surge cualquier otra cosa, solo env\u00eda un mensaje aqu\u00ed.',
    withdrawStillPending: 'Gracias por comprobarlo. Los retiros suelen llegar en 15-30 minutos tras la solicitud. Si el tuyo sigue pendiente despu\u00e9s de ese tiempo, puedo pasarlo a nuestro equipo: pueden revisarlo con la referencia de tu historial.',
    btnBusiness: '\ud83d\udcc4 Registro mercantil',
    btnHowItWorks: '\ud83c\udfa5 C\u00f3mo funciona Kalderix',
    withdrawTutorialLink: 'Tutorial de retiro de Kalderix: {{url}}',
    onboardCreateAccount: 'Puedes crear tu cuenta en el sitio web arbitrix.pro; solo lleva un minuto.',
    onboardRegisteredQuestion: '\u00bfYa has creado tu cuenta de Kalderix?',
    onboardRegisteredYes: 'Genial. \u00bfYa has hecho tu primer dep\u00f3sito?',
    onboardRegisteredNo: 'No hay problema. Puedes crear tu cuenta en el sitio de Kalderix y probar primero el Modo Demo si quieres. \u00bfQuieres ayuda con tu primer dep\u00f3sito?',
    onboardDepositedQuestion: '\u00bfYa has hecho tu primer dep\u00f3sito?',
    onboardDepositedYes: 'Genial. \u00bfYa aparece el dep\u00f3sito en tu saldo Live?',
    onboardDepositedNo: 'No hay problema: puedo guiarte en un dep\u00f3sito. \u00bfYa tienes USDT (TRC20) o quieres ayuda para comprarlo primero?',
    partnerOffer: 'Tambi\u00e9n puedo contarte nuestro programa de partners: ganas el 20 % del primer dep\u00f3sito v\u00e1lido de cada persona que refieras, una recompensa \u00fanica y sin comisiones recurrentes. \u00bfQuieres saber m\u00e1s?',
    partnerHow: 'Abre la secci\u00f3n Referidos en tu cuenta para encontrar tu enlace y c\u00f3digo de referido. Comp\u00e1rtelos con quien quiera probar Kalderix.',
    partnerDecline: 'No hay problema. \u00bfHay algo m\u00e1s en lo que pueda ayudarte?',
    help: [
        'Soporte de Kalderix',
        '',
        'Env\u00eda tu pregunta como un mensaje normal y un agente de soporte responder\u00e1 aqu\u00ed.',
        '/language - cambiar tu idioma',
        '/escalate - solicitar un agente humano',
        '/subscribe - novedades para partners en este chat',
        '/unsubscribe - detener las novedades para partners',
        '/tutorial - abrir los tutoriales de dep\u00f3sito y retiro',
        '/progress - ver d\u00f3nde lo dejaste en este chat',
        '/next - qu\u00e9 hacer a continuaci\u00f3n',
        '/chatid - mostrar el ID de este chat',
        '/unlink - desconectar este chat de tu cuenta de Kalderix',
    ].join('\n'),
    tutorialMenu: 'Estos son los tutoriales aprobados. Abre el que corresponda a c\u00f3mo quieres financiar tu cuenta:',
    progressTitle: 'En este chat hasta ahora:',
    progressWaiting: 'Pendiente de:',
    progressMethod: 'M\u00e9todo de dep\u00f3sito: {{method}}',
    progressEmpty: 'Todav\u00eda no hay nada en curso en este chat. Preg\u00fantame por dep\u00f3sitos, retiros, el programa de partners o pide hablar con una persona.',
    nextStepTitle: 'Tu siguiente paso:',
    nextTopics: '\u00bfQu\u00e9 quieres hacer ahora? Cu\u00e9ntame sobre dep\u00f3sitos, retiros, el programa de partners o pide hablar con una persona.',
    acknowledgement: 'Gracias por contactar con el Soporte de Kalderix. Describe tu problema y un agente de soporte te atender\u00e1 aqu\u00ed. Tambi\u00e9n puedes usar /language para cambiar tu idioma o /escalate para solicitar un agente humano.',
    tutorialCaption: '\u00bfPrefieres verlo? Aqu\u00ed tienes un breve tutorial del proceso de dep\u00f3sito.',
    escalationAck: 'Tu solicitud se ha marcado para un agente humano. Un miembro del equipo de soporte te responder\u00e1 en este chat.',
    textOnly: 'Env\u00eda un mensaje de texto para que nuestro equipo de soporte pueda ayudarte.',
    chatId: 'El ID de este chat es: {{id}}',
    subscribeSet: 'Est\u00e1s suscrito a las novedades para partners en este chat. Env\u00eda /unsubscribe cuando quieras para detenerlas.',
    unsubscribeSet: 'Te has dado de baja de las novedades para partners. Las respuestas de soporte en este chat no se ven afectadas.',
    subscribeUnavailable: 'Las novedades para partners no est\u00e1n disponibles ahora mismo. Tu conversaci\u00f3n de soporte no se ve afectada.',
    linkSuccess: 'Conectado. Este chat ya est\u00e1 vinculado a tu cuenta de Kalderix. Usa /unlink cuando quieras para desconectarlo. Vincular no te suscribe a mensajes de marketing: env\u00eda /subscribe si quieres recibir novedades para partners.',
    linkAlready: 'Este chat ya est\u00e1 vinculado a tu cuenta de Kalderix. No ha cambiado nada.',
    linkInvalid: 'Ese enlace de conexi\u00f3n no es v\u00e1lido o ha caducado. Crea un enlace nuevo desde tu panel de Kalderix.',
    linkChatTaken: 'Esta cuenta de Telegram ya est\u00e1 conectada a otra cuenta de Kalderix. Env\u00eda /unlink para desconectarla primero y luego crea un enlace nuevo desde la cuenta correcta.',
    linkAccountBusy: 'Tu cuenta de Kalderix ya est\u00e1 conectada a otro chat de Telegram. Descon\u00e9ctala primero desde tu panel y luego crea un enlace nuevo.',
    linkRateLimited: 'Demasiados intentos de conexi\u00f3n. Espera unos minutos e int\u00e9ntalo de nuevo.',
    linkUnavailable: 'La vinculaci\u00f3n de cuentas no est\u00e1 disponible temporalmente. Int\u00e9ntalo de nuevo m\u00e1s tarde.',
    unlinkRemoved: 'Desconectado. Este chat ya no est\u00e1 vinculado a ninguna cuenta de Kalderix.',
    unlinkNotLinked: 'Este chat no est\u00e1 vinculado a ninguna cuenta de Kalderix.',
    unlinkUnavailable: 'La desconexi\u00f3n no est\u00e1 disponible temporalmente. Int\u00e9ntalo de nuevo m\u00e1s tarde.',
    languagePrompt: 'Elige tu idioma:\nPuedes cambiarlo cuando quieras con /language.',
    languageSet: 'Idioma establecido en espa\u00f1ol. A partir de ahora responder\u00e9 en espa\u00f1ol.',
    languageUnsupported: 'Ese idioma a\u00fan no est\u00e1 disponible. Seguir\u00e9 respondiendo en {{language}}.',
    uncertain: 'No tengo una respuesta aprobada para eso y no quiero adivinar. Lo he marcado para nuestro equipo de soporte: una persona puede ayudarte aqu\u00ed.',
    humanHandoff: 'Es mejor que lo gestione nuestro equipo de soporte, as\u00ed que lo he pasado a una persona. Sigue atento a este chat y un miembro del equipo te atender\u00e1.',
    secretRefusal: 'No puedo compartir ni confirmar contrase\u00f1as, claves privadas, frases semilla ni c\u00f3digos de un solo uso, y el soporte de Kalderix nunca te los pedir\u00e1. Nunca los compartas con nadie. Si tienes un problema de acceso a la cuenta, usa \u00abHe olvidado mi contrase\u00f1a\u00bb o pide hablar con una persona aqu\u00ed.',
    secretShared: 'No compartas contrase\u00f1as, claves privadas, frases semilla ni c\u00f3digos de un solo uso aqu\u00ed. Por tu seguridad no lo he repetido. Si has compartido una credencial, c\u00e1mbiala de inmediato y pide ayuda a una persona si necesitas proteger tu cuenta.',
    paymentStatus: 'No tengo acceso a tu cuenta ni a los detalles de tu pago, as\u00ed que no puedo confirmar aqu\u00ed el estado de un dep\u00f3sito o retiro. Lo he pasado a nuestro equipo de soporte, que puede comprobarlo con la referencia de tu transacci\u00f3n.',
    aiDisabled: 'Las respuestas autom\u00e1ticas est\u00e1n desactivadas en este momento. He guardado tu mensaje y un miembro de nuestro equipo de soporte te ayudar\u00e1 aqu\u00ed.',
    promptForQuestion: 'Env\u00eda tu pregunta como un mensaje normal y un agente de soporte te atender\u00e1 aqu\u00ed.',
    storageDegraded: 'Hemos recibido tu mensaje. Nuestro sistema de soporte no est\u00e1 disponible temporalmente, por lo que nuestro equipo puede tardar m\u00e1s de lo habitual en responder.'
  }),
  pt: Object.freeze({
    greetingFresh: "Olá! Sou o assistente de suporte da Kalderix. Como posso ajudar você hoje?",
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
    depositNeedCrypto: "Sem problema - você pode comprar USDT por um serviço terceirizado compatível e depois enviá-lo para o seu endereço de depósito da Kalderix. Disponibilidade, formas de pagamento e taxas dependem do seu país e do provedor.",
    depositHaveCrypto: "Ótimo. Abra a opção Depositar no aplicativo, informe o valor e envie USDT na rede TRON (TRC20) para o endereço exato mostrado. Os depósitos são detectados automaticamente assim que a rede confirma.",
    depositMethodPrompt: "Para qual método você gostaria de ver o tutorial: Paybis, Transak ou Trust Wallet?",
    depositMethodPromptAgain: "Só me diga qual método você gostaria de usar: Paybis, Transak ou Trust Wallet.",
    depositTutorialLink: "Tutorial de depósito {{method}}: {{url}}",
    tutorialHow: "Abra o link do tutorial acima e siga os passos do método que você escolheu. Se algum passo não estiver claro, diga qual é e eu explico.",
    depositTutorialFollowUp: "Siga os passos do tutorial e me avise se tiver qualquer dificuldade.",
    depositAfterAck: "Ótimo. Depois de enviar os fundos, escreva \"concluído\" e eu explico o próximo passo.",
    depositCompletedAskTransfer: "Excelente! Você conseguiu transferir os fundos para o seu endereço de depósito da Kalderix?",
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
    trustWhatWeDo: "A Kalderix é uma empresa registrada que opera uma plataforma automatizada de arbitragem multi-ativos, criada para identificar oportunidades de negociação que surgem das diferenças de preço entre as corretoras suportadas.",
    trustExploreIntro: "Aqui estão algumas coisas que você pode explorar:",
    trustPoints: "✅ Empresa registrada: a Kalderix possui dados oficiais de registro empresarial que você pode consultar e verificar.\n✅ Teste o Modo Demo: veja como a plataforma funciona com fundos simulados antes de mudar para o Modo Live.\n✅ Saiba como funciona: temos explicações e vídeos tutoriais para orientar você pela plataforma.\n✅ Onboarding fácil: nossa equipe de suporte está disponível para orientar você no cadastro, nos depósitos e na navegação da plataforma.",
    trustLinksIntro: "Você pode consultar nossas páginas oficiais aqui:",
    trustLinks: "📄 Registro empresarial:\nhttps://arbitrix.pro/business-registration\n\n🎥 Como a Kalderix funciona:\nhttps://arbitrix.pro/how-it-works",
    trustClose: "Teremos prazer em ajudar você a entender tudo e a se familiarizar com a plataforma.",
    trustSupportLine: "Voc\u00ea tamb\u00e9m pode responder \"humano\" a qualquer momento e um membro da nossa equipe de suporte assumir\u00e1 a conversa aqui.",
    trustQuestion: "Gostaria de um guia rápido sobre como a Kalderix funciona? 😊",
    trustVerify: "Nossos dados de registro estão publicados aqui: https://arbitrix.pro/business-registration\n\nEles mostram que a Kalderix é operada pela Arbitrix Trading, registrada na Câmara de Comércio dos Países Baixos (KVK) sob o número 72923513. Você pode abrir o certificado de registro nessa página.",
    trustCertificate: "O certificado de registro está na mesma página - abra o certificado para vê-lo em tamanho maior ou baixá-lo. Não consigo enviar documentos por este chat, mas se você precisar de uma cópia oficial nossa equipe pode ajudar - responda \"humano\".",
    trustLimits: "Não tenho mais detalhes sobre isso além do que está publicado em nossas páginas oficiais, e não quero adivinhar. Se quiser, posso pedir ajuda à nossa equipe de suporte - responda \"humano\".",
    platformIntro: "A Kalderix é uma plataforma automatizada de arbitragem multi-ativos. Ela identifica diferenças de preço do mesmo ativo entre as corretoras suportadas e automatiza as negociações que aproveitam essas diferenças.",
    platformBullets: "• Modo Demo: explore a plataforma com fundos simulados - sem necessidade de depósito.\n• Modo Live: negocie com dinheiro real após um depósito de pelo menos US$ 50.\n• Automação: o bot executa a estratégia por você, e você acompanha os resultados no painel.",
    platformLink: "Veja como funciona, com um vídeo explicativo: https://arbitrix.pro/how-it-works",
    platformQuestion: "Gostaria de saber como começar?",
    earningsIntro: "Os retornos de negociação variam conforme as condições de mercado e as oportunidades de arbitragem disponíveis. Não existe renda diária fixa nem lucro garantido.",
    earningsVaries: "A Kalderix identifica oportunidades entre as corretoras suportadas e automatiza a negociação, mas os resultados reais podem variar. O trading envolve risco - você pode perder dinheiro, não apenas ganhar.",
    earningsDemo: "Você pode explorar a plataforma no Modo Demo com fundos simulados antes de decidir usar o Modo Live.",
    earningsQuestion: "Gostaria que eu mostrasse como a plataforma funciona?",
    guideOfferQuestion: "Gostaria de um guia rápido sobre como a Kalderix funciona?",
    withdrawChecked: "Certo! 😊 Se o seu saque aparece como concluído e os fundos chegaram, está tudo certo. Se ainda estiver pendente ou você não tiver recebido os fundos, me avise e eu ajudo você a verificar o que fazer.",
    withdrawArrived: "Obrigado por confirmar. Fico feliz que os fundos tenham chegado. Se surgir qualquer outra coisa, é só enviar uma mensagem aqui.",
    withdrawStillPending: "Obrigado por verificar. Os saques geralmente chegam em 15-30 minutos após o pedido. Se o seu ainda estiver pendente depois disso, posso encaminhar à nossa equipe - eles conseguem verificar com a referência do seu histórico.",
    btnBusiness: "📄 Registro empresarial",
    btnHowItWorks: "🎥 Como a Kalderix funciona",
    withdrawTutorialLink: "Tutorial de saque da Kalderix: {{url}}",
    onboardCreateAccount: "Você pode criar sua conta no site arbitrix.pro - leva cerca de um minuto.",
    onboardRegisteredQuestion: "Você já criou sua conta na Kalderix?",
    onboardRegisteredYes: "Ótimo. Você já fez o seu primeiro depósito?",
    onboardRegisteredNo: "Sem problema. Você pode criar sua conta no site da Kalderix e experimentar o Modo Demo primeiro, se quiser. Gostaria de ajuda com o seu primeiro depósito?",
    onboardDepositedQuestion: "Você já fez o seu primeiro depósito?",
    onboardDepositedYes: "Ótimo. O depósito já aparece no seu saldo Live?",
    onboardDepositedNo: "Sem problema - posso orientar você em um depósito. Você já tem USDT (TRC20) ou gostaria de ajuda para comprar primeiro?",
    partnerOffer: "Também posso falar sobre o nosso programa de parceiros: você ganha 20% do primeiro depósito qualificado de cada pessoa que indicar - uma recompensa única, sem comissão recorrente. Gostaria de saber mais?",
    partnerHow: "Abra a seção Indicações na sua conta para encontrar seu link e código de indicação. Compartilhe com quem quiser experimentar a Kalderix.",
    partnerDecline: "Sem problema. Posso ajudar com mais alguma coisa?",
    help: [
      'Suporte Kalderix',
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
      '/unlink - desvincular esta conversa da sua conta Kalderix'
    ].join('\n'),
      tutorialMenu: 'Estes sao os tutoriais aprovados. Abra o que corresponde a forma como quer financiar a sua conta:',
      progressTitle: 'Nesta conversa ate agora:',
      progressWaiting: 'A espera de:',
      progressMethod: 'Metodo de deposito: {{method}}',
      progressEmpty: 'Ainda nao ha nada em andamento nesta conversa. Pergunte-me sobre depositos, levantamentos, o programa de parceiros, ou peca um atendente humano.',
      nextStepTitle: 'O seu proximo passo:',
      nextTopics: 'O que quer fazer a seguir? Fale-me de depositos, levantamentos, do programa de parceiros, ou peca um atendente humano.',
    acknowledgement: 'Obrigado por entrar em contato com o Suporte Kalderix. Descreva o seu problema e um agente de suporte vai ajudar você por aqui. Você também pode usar /language para alterar o idioma ou /escalate para falar com um atendente humano.',
    tutorialCaption: 'Prefere assistir? Aqui está um passo a passo curto do processo de depósito.',
    escalationAck: 'Seu pedido foi encaminhado para um atendente humano. Um membro da equipe de suporte vai responder nesta conversa.',
    textOnly: 'Por favor, envie uma mensagem de texto para que a nossa equipe de suporte possa ajudar.',
    chatId: 'O ID desta conversa é: {{id}}',
    subscribeSet: 'Você está inscrito nas novidades para parceiros neste chat. Envie /unsubscribe a qualquer momento para cancelar.',
    unsubscribeSet: 'Sua inscrição nas novidades para parceiros foi cancelada. As respostas de suporte neste chat não são afetadas.',
    subscribeUnavailable: 'As novidades para parceiros não estão disponíveis no momento. Sua conversa de suporte não é afetada.',
    linkSuccess: 'Conectado. Esta conversa agora está vinculada à sua conta Kalderix. Use /unlink a qualquer momento para desconectar. O vínculo não inscreve você em mensagens de marketing - envie /subscribe se quiser receber novidades para parceiros.',
    linkAlready: 'Esta conversa já está vinculada à sua conta Kalderix. Nada foi alterado.',
    linkInvalid: 'Esse link de conexão não é válido ou expirou. Crie um novo link no painel da sua conta Kalderix.',
    linkChatTaken: 'Esta conta do Telegram já está conectada a outra conta Kalderix. Envie /unlink para desconectá-la primeiro e depois crie um novo link na conta correta.',
    linkAccountBusy: 'Sua conta Kalderix já está conectada a outra conversa do Telegram. Desconecte-a no painel primeiro e depois crie um novo link.',
    linkRateLimited: 'Muitas tentativas de conexão. Aguarde alguns minutos e tente novamente.',
    linkUnavailable: 'A vinculação de conta está temporariamente indisponível. Tente novamente mais tarde.',
    unlinkRemoved: 'Desconectado. Esta conversa não está mais vinculada a uma conta Kalderix.',
    unlinkNotLinked: 'Esta conversa não está vinculada a uma conta Kalderix.',
    unlinkUnavailable: 'A desconexão está temporariamente indisponível. Tente novamente mais tarde.',
    languagePrompt: 'Escolha o seu idioma:\nVocê pode alterar quando quiser com /language.',
    languageSet: 'Idioma definido como Português. A partir de agora, responderei em português.',
    languageUnsupported: 'Esse idioma ainda não está disponível. Vou continuar respondendo em {{language}}.',
    uncertain: 'Não tenho uma resposta aprovada para isso e não quero adivinhar. Encaminhei o seu caso para a nossa equipe de suporte — um atendente humano pode ajudar você por aqui.',
    humanHandoff: 'É melhor que a nossa equipe de suporte cuide disso, então encaminhei o seu caso para um atendente humano. Fique de olho nesta conversa e um membro da equipe vai ajudar você.',
    secretRefusal: 'Não posso compartilhar nem confirmar senhas, chaves privadas, frases de recuperação (seed) ou códigos de uso único, e o suporte da Kalderix nunca vai pedir esses dados a você. Nunca compartilhe isso com ninguém. Se você tiver um problema de acesso à conta, use "Esqueci minha senha" ou peça ajuda a um atendente por aqui.',
    secretShared: 'Por favor, não compartilhe senhas, chaves privadas, frases de recuperação (seed) ou códigos de uso único aqui. Para a sua segurança, não repeti o conteúdo. Se você compartilhou uma credencial, altere-a imediatamente e peça ajuda a um atendente para proteger a sua conta.',
    paymentStatus: 'Não tenho acesso à sua conta nem aos detalhes do seu pagamento, então não posso confirmar por aqui o status de um depósito ou saque. Encaminhei o seu caso para a nossa equipe de suporte, que pode verificar isso usando a referência da sua transação.',
    aiDisabled: 'As respostas automáticas estão desativadas no momento. Salvei a sua mensagem e um membro da nossa equipe de suporte vai ajudar você por aqui.',
    promptForQuestion: 'Por favor, envie a sua pergunta como uma mensagem normal e um agente de suporte vai ajudar você por aqui.',
    storageDegraded: 'Recebemos a sua mensagem. Nosso sistema de suporte está temporariamente indisponível, então a nossa equipe pode demorar um pouco mais para responder.'
  }),
    fr: Object.freeze({
    greetingFresh: 'Bonjour ! Je suis l\'assistant du support Kalderix. Comment puis-je vous aider aujourd\'hui ?',
    greetingAgain: 'Rebonjour ! Que puis-je faire pour vous ?',
    clarifyTopic: 'D\u00e9sol\u00e9, je n\'ai peut-\u00eatre pas compris. Votre question porte-t-elle sur un d\u00e9p\u00f4t, le d\u00e9marrage d\'un trade ou un retrait ?',
    clarifyHelp: 'Je peux vous aider pour les d\u00e9p\u00f4ts, les retraits, le trading, la v\u00e9rification, le parrainage ou les questions de compte. Sur quoi avez-vous besoin d\'aide ?',
    thanksClose: 'Je vous en prie ! Si vous avez besoin d\'autre chose, \u00e9crivez simplement ici.',
    thanksOpen: 'Je vous en prie ! Pour reprendre l\u00e0 o\u00f9 nous en \u00e9tions :',
    ackNoQuestion: 'C\'est not\u00e9. Sur quoi avez-vous besoin d\'aide ?',
    anythingElse: 'Puis-je vous aider pour autre chose ?',
    socialAck: 'Tr\u00e8s bien ! Dites-moi si vous avez besoin d\'autre chose.',
    socialUnderstood: 'Parfait ! Dites-moi si vous avez besoin de pr\u00e9cisions.',
    socialPositive: 'Ravi de l\'entendre ! Puis-je vous aider pour autre chose ?',
    socialGreat: 'Formidable ! N\'h\u00e9sitez pas \u00e0 demander si besoin.',
    socialThanks: 'Je vous en prie ! Ravi d\'avoir pu aider.',
    socialThanksBig: 'Avec grand plaisir ! Nous sommes l\u00e0 d\u00e8s que vous avez besoin d\'aide.',
    socialReciprocal: '\u00c0 tout moment ! Bonne journ\u00e9e.',
    socialClosing: 'C\'est not\u00e9. Je suis l\u00e0 si besoin.',
    reassure: 'Oui, c\'est exact d\'apr\u00e8s les informations dont je dispose. Souhaitez-vous plus de d\u00e9tails ?',
    depositIntro: 'Je peux vous aider. Avez-vous d\u00e9j\u00e0 de l\'USDT (TRC20) dans votre propre portefeuille, ou souhaitez-vous de l\'aide pour en acheter d\'abord ?',
    depositWantHelpQuestion: 'Souhaitez-vous de l\'aide pour votre premier d\u00e9p\u00f4t ?',
    depositNeedCrypto: 'Pas de probl\u00e8me : vous pouvez acheter de l\'USDT via un service tiers compatible, puis l\'envoyer \u00e0 votre adresse de d\u00e9p\u00f4t Kalderix. La disponibilit\u00e9, les moyens de paiement et les frais d\u00e9pendent de votre pays et du prestataire.',
    depositHaveCrypto: 'Tr\u00e8s bien. Ouvrez D\u00e9p\u00f4t dans l\'application, saisissez votre montant et envoyez de l\'USDT sur le r\u00e9seau TRON (TRC20) \u00e0 l\'adresse exacte affich\u00e9e. Les d\u00e9p\u00f4ts sont d\u00e9tect\u00e9s automatiquement d\u00e8s que le r\u00e9seau les confirme.',
    depositMethodPrompt: 'Pour quelle m\u00e9thode souhaitez-vous un tutoriel : Paybis, Transak ou Trust Wallet ?',
    depositMethodPromptAgain: 'Indiquez-moi simplement la m\u00e9thode que vous souhaitez utiliser : Paybis, Transak ou Trust Wallet.',
    depositTutorialLink: 'Tutoriel de d\u00e9p\u00f4t {{method}} : {{url}}',
    tutorialHow: 'Ouvrez le lien du tutoriel ci-dessus et suivez les \u00e9tapes de la m\u00e9thode choisie. Si une \u00e9tape n\'est pas claire, dites-moi laquelle et je vous l\'expliquerai.',
    depositTutorialFollowUp: 'Suivez les \u00e9tapes du tutoriel et dites-moi si vous rencontrez une difficult\u00e9.',
    depositAfterAck: 'Tr\u00e8s bien. Une fois les fonds envoy\u00e9s, \u00e9crivez \u00ab fait \u00bb et je vous indiquerai l\'\u00e9tape suivante.',
    depositCompletedAskTransfer: 'Excellent ! Avez-vous bien transf\u00e9r\u00e9 les fonds vers votre adresse de d\u00e9p\u00f4t Kalderix ?',
    depositTransferNo: 'Ce n\'est pas grave, prenez votre temps. Je suis l\u00e0 quand vous serez pr\u00eat. Voulez-vous revoir le tutoriel {{method}} ?',
    depositTransferNoGeneric: 'Ce n\'est pas grave, prenez votre temps. Je suis l\u00e0 quand vous serez pr\u00eat. Voulez-vous revoir le tutoriel de d\u00e9p\u00f4t ?',
    depositTransferYes: 'Tr\u00e8s bien. Les d\u00e9p\u00f4ts sont g\u00e9n\u00e9ralement d\u00e9tect\u00e9s automatiquement d\u00e8s que le r\u00e9seau les confirme. Le d\u00e9p\u00f4t appara\u00eet-il maintenant dans votre solde Live ?',
    depositCreditedQuestion: 'Le d\u00e9p\u00f4t appara\u00eet-il maintenant dans votre solde Live ?',
    depositCreditedYes: 'Tr\u00e8s bien. Si le d\u00e9p\u00f4t appara\u00eet dans votre solde Live, vous pouvez trader en Mode Live. S\'il n\'appara\u00eet pas encore, \u00e9crivez \u00ab humain \u00bb et notre \u00e9quipe v\u00e9rifiera pour vous.',
    depositCreditedNo: 'Merci d\'avoir v\u00e9rifi\u00e9. Les d\u00e9p\u00f4ts sont g\u00e9n\u00e9ralement confirm\u00e9s en quelques minutes. Conservez la r\u00e9f\u00e9rence de votre facture et n\'envoyez pas le paiement deux fois. S\'il n\'appara\u00eet toujours pas, \u00e9crivez \u00ab humain \u00bb et notre \u00e9quipe v\u00e9rifiera pour vous.',
    withdrawIntro: 'Je peux vous aider pour les retraits. Vous demandez un retrait vers l\'adresse de votre portefeuille depuis votre solde Live, et il appara\u00eet comme en attente dans votre historique pendant le traitement.',
    withdrawTiming: 'Les retraits arrivent g\u00e9n\u00e9ralement sous 15 \u00e0 30 minutes. Vous pouvez suivre le statut dans votre historique de transactions.',
    withdrawHelpPrompt: 'Souhaitez-vous de l\'aide pour un probl\u00e8me de retrait pr\u00e9cis ?',
    trustIntro: 'Excellente question ! C\'est toujours utile de mieux conna\u00eetre une plateforme avant de commencer.',
    trustWhatWeDo: 'Kalderix est une entreprise enregistr\u00e9e qui exploite une plateforme d\'arbitrage multi-actifs automatis\u00e9e, con\u00e7ue pour identifier les opportunit\u00e9s de trading issues des \u00e9carts de prix entre les plateformes prises en charge.',
    trustExploreIntro: 'Voici quelques \u00e9l\u00e9ments que vous pouvez explorer :',
    trustPoints: '\u2705 Entreprise enregistr\u00e9e : Kalderix dispose de donn\u00e9es officielles d\'immatriculation que vous pouvez consulter et v\u00e9rifier.\n\u2705 Essayez le Mode d\u00e9mo : d\u00e9couvrez le fonctionnement de la plateforme avec des fonds simul\u00e9s avant de passer en Mode Live.\n\u2705 D\u00e9couvrez le fonctionnement : nous proposons des explications et des tutoriels vid\u00e9o pour vous guider.\n\u2705 Int\u00e9gration simple : notre \u00e9quipe support peut vous accompagner pour l\'inscription, les d\u00e9p\u00f4ts et la navigation sur la plateforme.',
    trustLinksIntro: 'Vous pouvez consulter nos pages officielles ici :',
    trustLinks: '\ud83d\udcc4 Immatriculation de l\'entreprise :\nhttps://arbitrix.pro/business-registration\n\n\ud83c\udfa5 Comment fonctionne Kalderix :\nhttps://arbitrix.pro/how-it-works',
    trustClose: 'Nous sommes ravis de vous aider \u00e0 tout comprendre et \u00e0 vous familiariser avec la plateforme.',
    trustSupportLine: 'Vous pouvez aussi \u00e9crire \u00ab humain \u00bb \u00e0 tout moment : un membre de notre \u00e9quipe support prendra le relais ici.',
    trustQuestion: 'Souhaitez-vous un guide rapide sur le fonctionnement de Kalderix ?',
    trustVerify: 'Nos donn\u00e9es d\'immatriculation sont publi\u00e9es ici : https://arbitrix.pro/business-registration\n\nElles indiquent que Kalderix est exploit\u00e9e par Arbitrix Trading, immatricul\u00e9e \u00e0 la Chambre de commerce des Pays-Bas (KVK) sous le num\u00e9ro KVK 72923513. Vous pouvez ouvrir le certificat d\'immatriculation sur cette page.',
    trustCertificate: 'Le certificat d\'immatriculation se trouve sur la m\u00eame page : ouvrez-le pour le voir en grand ou le t\u00e9l\u00e9charger. Je ne peux pas envoyer de documents via ce chat, mais si vous avez besoin d\'une copie officielle, notre \u00e9quipe peut vous aider : \u00e9crivez \u00ab humain \u00bb.',
    trustLimits: 'Je n\'ai pas plus de d\u00e9tails que ce qui est publi\u00e9 sur nos pages officielles, et je ne veux pas deviner. Si vous le souhaitez, je peux demander l\'aide de notre \u00e9quipe support : \u00e9crivez \u00ab humain \u00bb.',
    platformIntro: 'Kalderix est une plateforme d\'arbitrage multi-actifs automatis\u00e9e. Elle identifie les \u00e9carts de prix d\'un m\u00eame actif entre les plateformes prises en charge et automatise les transactions qui en profitent.',
    platformBullets: '\u2022 Mode d\u00e9mo : explorez la plateforme avec des fonds simul\u00e9s, sans d\u00e9p\u00f4t n\u00e9cessaire.\n\u2022 Mode Live : tradez avec des fonds r\u00e9els apr\u00e8s un d\u00e9p\u00f4t d\'au moins 50 $.\n\u2022 Automatisation : le bot ex\u00e9cute la strat\u00e9gie pour vous et vous suivez les r\u00e9sultats dans votre tableau de bord.',
    platformLink: 'D\u00e9couvrez le fonctionnement avec un tutoriel vid\u00e9o : https://arbitrix.pro/how-it-works',
    platformQuestion: 'Souhaitez-vous savoir comment commencer ?',
    earningsIntro: 'Les rendements du trading varient selon les conditions de march\u00e9 et les opportunit\u00e9s d\'arbitrage disponibles. Il n\'y a ni revenu quotidien fixe ni profit garanti.',
    earningsVaries: 'Kalderix identifie des opportunit\u00e9s entre les plateformes prises en charge et automatise le trading, mais les r\u00e9sultats r\u00e9els peuvent varier. Le trading comporte des risques : vous pouvez perdre de l\'argent, pas seulement en gagner.',
    earningsDemo: 'Vous pouvez explorer la plateforme en Mode d\u00e9mo avec des fonds simul\u00e9s avant de d\u00e9cider d\'utiliser le Mode Live.',
    earningsQuestion: 'Souhaitez-vous que je vous montre comment fonctionne la plateforme ?',
    guideOfferQuestion: 'Souhaitez-vous un guide rapide sur le fonctionnement de Kalderix ?',
    withdrawChecked: 'Tr\u00e8s bien ! Si votre retrait appara\u00eet comme termin\u00e9 et que les fonds sont arriv\u00e9s, tout est en ordre. S\'il est encore en attente ou que vous n\'avez pas re\u00e7u les fonds, dites-le-moi et je vous aiderai \u00e0 v\u00e9rifier la suite.',
    withdrawArrived: 'Merci pour la confirmation. Je suis content que les fonds soient arriv\u00e9s. Si autre chose se pr\u00e9sente, \u00e9crivez simplement ici.',
    withdrawStillPending: 'Merci d\'avoir v\u00e9rifi\u00e9. Les retraits arrivent g\u00e9n\u00e9ralement sous 15 \u00e0 30 minutes apr\u00e8s la demande. Si le v\u00f4tre est encore en attente ensuite, je peux le transmettre \u00e0 notre \u00e9quipe : elle pourra v\u00e9rifier avec la r\u00e9f\u00e9rence de votre historique.',
    btnBusiness: '\ud83d\udcc4 Immatriculation de l\'entreprise',
    btnHowItWorks: '\ud83c\udfa5 Comment fonctionne Kalderix',
    withdrawTutorialLink: 'Tutoriel de retrait Kalderix : {{url}}',
    onboardCreateAccount: 'Vous pouvez cr\u00e9er votre compte sur le site arbitrix.pro : cela prend environ une minute.',
    onboardRegisteredQuestion: 'Avez-vous d\u00e9j\u00e0 cr\u00e9\u00e9 votre compte Kalderix ?',
    onboardRegisteredYes: 'Tr\u00e8s bien. Avez-vous d\u00e9j\u00e0 effectu\u00e9 votre premier d\u00e9p\u00f4t ?',
    onboardRegisteredNo: 'Pas de probl\u00e8me. Vous pouvez cr\u00e9er votre compte sur le site Kalderix et essayer d\'abord le Mode d\u00e9mo si vous le souhaitez. Souhaitez-vous de l\'aide pour votre premier d\u00e9p\u00f4t ?',
    onboardDepositedQuestion: 'Avez-vous d\u00e9j\u00e0 effectu\u00e9 votre premier d\u00e9p\u00f4t ?',
    onboardDepositedYes: 'Tr\u00e8s bien. Le d\u00e9p\u00f4t appara\u00eet-il maintenant dans votre solde Live ?',
    onboardDepositedNo: 'Pas de probl\u00e8me : je peux vous guider pour un d\u00e9p\u00f4t. Avez-vous d\u00e9j\u00e0 de l\'USDT (TRC20), ou souhaitez-vous de l\'aide pour en acheter d\'abord ?',
    partnerOffer: 'Je peux aussi vous parler de notre programme partenaire : vous gagnez 20 % du premier d\u00e9p\u00f4t \u00e9ligible de chaque personne que vous parrainez, une r\u00e9compense unique et sans commission r\u00e9currente. Souhaitez-vous en savoir plus ?',
    partnerHow: 'Ouvrez la section Parrainage dans votre compte pour trouver votre lien et votre code de parrainage. Partagez-les avec ceux qui veulent essayer Kalderix.',
    partnerDecline: 'Pas de probl\u00e8me. Puis-je vous aider pour autre chose ?',
    help: [
        'Support Kalderix',
        '',
        'Envoyez votre question comme un message normal et un agent du support vous r\u00e9pondra ici.',
        '/language - changer de langue',
        '/escalate - demander un agent humain',
        '/subscribe - actualit\u00e9s partenaires dans ce chat',
        '/unsubscribe - arr\u00eater les actualit\u00e9s partenaires',
        '/tutorial - ouvrir les tutoriels de d\u00e9p\u00f4t et de retrait',
        '/progress - voir o\u00f9 vous en \u00e9tiez dans ce chat',
        '/next - la prochaine \u00e9tape',
        '/chatid - afficher l\'ID de ce chat',
        '/unlink - dissocier ce chat de votre compte Kalderix',
    ].join('\n'),
    tutorialMenu: 'Voici les tutoriels approuv\u00e9s. Ouvrez celui qui correspond \u00e0 votre fa\u00e7on de financer votre compte :',
    progressTitle: 'Dans ce chat jusqu\'\u00e0 pr\u00e9sent :',
    progressWaiting: 'En attente de :',
    progressMethod: 'M\u00e9thode de d\u00e9p\u00f4t : {{method}}',
    progressEmpty: 'Rien n\'est encore en cours dans ce chat. Posez-moi une question sur les d\u00e9p\u00f4ts, les retraits, le programme partenaire, ou demandez un humain.',
    nextStepTitle: 'Votre prochaine \u00e9tape :',
    nextTopics: 'Que souhaitez-vous faire ensuite ? Parlez-moi des d\u00e9p\u00f4ts, des retraits, du programme partenaire, ou demandez un humain.',
    acknowledgement: 'Merci d\'avoir contact\u00e9 le Support Kalderix. D\u00e9crivez votre probl\u00e8me et un agent du support vous aidera ici. Vous pouvez aussi utiliser /language pour changer de langue ou /escalate pour demander un agent humain.',
    tutorialCaption: 'Vous pr\u00e9f\u00e9rez regarder ? Voici un court tutoriel du processus de d\u00e9p\u00f4t.',
    escalationAck: 'Votre demande a \u00e9t\u00e9 transmise \u00e0 un agent humain. Un membre de l\'\u00e9quipe support vous r\u00e9pondra dans ce chat.',
    textOnly: 'Veuillez envoyer un message texte afin que notre \u00e9quipe support puisse vous aider.',
    chatId: 'L\'ID de ce chat est : {{id}}',
    subscribeSet: 'Vous \u00eates abonn\u00e9 aux actualit\u00e9s partenaires dans ce chat. Envoyez /unsubscribe \u00e0 tout moment pour les arr\u00eater.',
    unsubscribeSet: 'Vous \u00eates d\u00e9sabonn\u00e9 des actualit\u00e9s partenaires. Les r\u00e9ponses du support dans ce chat ne sont pas affect\u00e9es.',
    subscribeUnavailable: 'Les actualit\u00e9s partenaires ne sont pas disponibles pour le moment. Votre conversation avec le support n\'est pas affect\u00e9e.',
    linkSuccess: 'Connect\u00e9. Ce chat est d\u00e9sormais li\u00e9 \u00e0 votre compte Kalderix. Utilisez /unlink \u00e0 tout moment pour le dissocier. La liaison ne vous abonne pas aux messages marketing : envoyez /subscribe si vous souhaitez les actualit\u00e9s partenaires.',
    linkAlready: 'Ce chat est d\u00e9j\u00e0 li\u00e9 \u00e0 votre compte Kalderix. Rien n\'a chang\u00e9.',
    linkInvalid: 'Ce lien de connexion n\'est pas valide ou a expir\u00e9. Cr\u00e9ez un nouveau lien depuis votre tableau de bord Kalderix.',
    linkChatTaken: 'Ce compte Telegram est d\u00e9j\u00e0 connect\u00e9 \u00e0 un autre compte Kalderix. Envoyez /unlink pour le dissocier d\'abord, puis cr\u00e9ez un nouveau lien depuis le bon compte.',
    linkAccountBusy: 'Votre compte Kalderix est d\u00e9j\u00e0 connect\u00e9 \u00e0 un autre chat Telegram. Dissociez-le d\'abord depuis votre tableau de bord, puis cr\u00e9ez un nouveau lien.',
    linkRateLimited: 'Trop de tentatives de connexion. Patientez quelques minutes et r\u00e9essayez.',
    linkUnavailable: 'La liaison de compte est temporairement indisponible. Veuillez r\u00e9essayer plus tard.',
    unlinkRemoved: 'Dissoci\u00e9. Ce chat n\'est plus li\u00e9 \u00e0 un compte Kalderix.',
    unlinkNotLinked: 'Ce chat n\'est li\u00e9 \u00e0 aucun compte Kalderix.',
    unlinkUnavailable: 'La dissociation est temporairement indisponible. Veuillez r\u00e9essayer plus tard.',
    languagePrompt: 'Choisissez votre langue :\nVous pouvez la changer \u00e0 tout moment avec /language.',
    languageSet: 'Langue d\u00e9finie sur le fran\u00e7ais. Je r\u00e9pondrai d\u00e9sormais en fran\u00e7ais.',
    languageUnsupported: 'Cette langue n\'est pas encore disponible. Je continuerai \u00e0 r\u00e9pondre en {{language}}.',
    uncertain: 'Je n\'ai pas de r\u00e9ponse approuv\u00e9e pour cela et je ne veux pas deviner. J\'ai signal\u00e9 votre question \u00e0 notre \u00e9quipe support : un humain peut vous aider ici.',
    humanHandoff: 'Il vaut mieux que notre \u00e9quipe support s\'en occupe ; j\'ai donc transmis votre demande \u00e0 un humain. Surveillez ce chat et un membre de l\'\u00e9quipe vous aidera.',
    secretRefusal: 'Je ne peux pas partager ni confirmer des mots de passe, cl\u00e9s priv\u00e9es, phrases de r\u00e9cup\u00e9ration (seed) ou codes \u00e0 usage unique, et le support Kalderix ne vous les demandera jamais. Ne les partagez avec personne. En cas de probl\u00e8me d\'acc\u00e8s \u00e0 votre compte, utilisez \u00ab Mot de passe oubli\u00e9 \u00bb ou demandez un humain ici.',
    secretShared: 'Ne partagez pas de mots de passe, cl\u00e9s priv\u00e9es, phrases de r\u00e9cup\u00e9ration (seed) ou codes \u00e0 usage unique ici. Pour votre s\u00e9curit\u00e9, je ne les ai pas r\u00e9p\u00e9t\u00e9s. Si vous avez partag\u00e9 un identifiant, changez-le imm\u00e9diatement et demandez un humain pour s\u00e9curiser votre compte.',
    paymentStatus: 'Je n\'ai pas acc\u00e8s \u00e0 votre compte ni aux d\u00e9tails de votre paiement, je ne peux donc pas confirmer ici le statut d\'un d\u00e9p\u00f4t ou d\'un retrait. J\'ai transmis la demande \u00e0 notre \u00e9quipe support, qui pourra v\u00e9rifier avec la r\u00e9f\u00e9rence de votre transaction.',
    aiDisabled: 'Les r\u00e9ponses automatiques sont actuellement d\u00e9sactiv\u00e9es. J\'ai enregistr\u00e9 votre message et un membre de notre \u00e9quipe support vous aidera ici.',
    promptForQuestion: 'Envoyez votre question comme un message normal et un agent du support vous aidera ici.',
    storageDegraded: 'Nous avons bien re\u00e7u votre message. Notre syst\u00e8me de support est temporairement indisponible, notre \u00e9quipe peut donc mettre plus de temps que d\'habitude \u00e0 r\u00e9pondre.'
  }),
  ar: Object.freeze({
    greetingFresh: "مرحبًا! أنا مساعد دعم Kalderix. كيف يمكنني مساعدتك اليوم؟",
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
    depositNeedCrypto: "لا مشكلة - يمكنك شراء USDT عبر خدمة طرف ثالث مدعومة، ثم إرساله إلى عنوان الإيداع الخاص بك في Kalderix. يعتمد التوفر وطرق الدفع والرسوم على بلدك وعلى مزوّد الخدمة.",
    depositHaveCrypto: "رائع. افتح خيار الإيداع في التطبيق، وأدخل المبلغ، ثم أرسل USDT على شبكة TRON (TRC20) إلى العنوان الظاهر تمامًا. يتم اكتشاف الإيداعات تلقائيًا بعد تأكيد الشبكة.",
    depositMethodPrompt: "لأي طريقة تريد مشاهدة الدرس: Paybis أم Transak أم Trust Wallet؟",
    depositMethodPromptAgain: "أخبرني فقط بالطريقة التي تريد استخدامها: Paybis أو Transak أو Trust Wallet.",
    depositTutorialLink: "درس إيداع {{method}}: {{url}}",
    tutorialHow: "افتح رابط الدرس أعلاه واتبع الخطوات للطريقة التي اخترتها. إذا كانت خطوة معينة غير واضحة، أخبرني بأي خطوة وسأشرحها.",
    depositTutorialFollowUp: "اتبع الخطوات في الدرس وأخبرني إذا واجهت أي صعوبة.",
    depositAfterAck: "رائع. بعد إرسال الأموال، اكتب \"تم\" وسأوضح لك الخطوة التالية.",
    depositCompletedAskTransfer: "ممتاز! هل نجحت في تحويل الأموال إلى عنوان الإيداع الخاص بك في Kalderix؟",
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
    trustWhatWeDo: "Kalderix شركة مسجّلة تدير منصة أتمتة للمراجحة متعددة الأصول، صُممت لتحديد فرص التداول الناشئة عن فروق الأسعار بين المنصات المدعومة.",
    trustExploreIntro: "إليك بعض الأمور التي يمكنك استكشافها:",
    trustPoints: "✅ شركة مسجّلة: لدى Kalderix بيانات رسمية للسجل التجاري يمكنك الاطلاع عليها والتحقق منها.\n✅ جرّب الوضع التجريبي: استكشف طريقة عمل المنصة بأموال محاكاة قبل الانتقال إلى الوضع المباشر.\n✅ تعرّف على طريقة العمل: لدينا شروحات وفيديوهات تعليمية لإرشادك في المنصة.\n✅ بدء سهل: فريق الدعم لدينا مستعد لإرشادك خلال التسجيل والإيداع والتنقل في المنصة.",
    trustLinksIntro: "يمكنك الاطلاع على صفحاتنا الرسمية هنا:",
    trustLinks: "📄 السجل التجاري:\nhttps://arbitrix.pro/business-registration\n\n🎥 كيف تعمل Kalderix:\nhttps://arbitrix.pro/how-it-works",
    trustClose: "يسعدنا مساعدتك على فهم كل شيء والتعوّد على المنصة.",
    trustSupportLine: "\u064a\u0645\u0643\u0646\u0643 \u0623\u064a\u0636\u064b\u0627 \u0627\u0644\u0631\u062f \u0628\u0643\u0644\u0645\u0629 \"\u0628\u0634\u0631\u064a\" \u0641\u064a \u0623\u064a \u0648\u0642\u062a \u0648\u0633\u064a\u062a\u0648\u0644\u0649 \u0623\u062d\u062f \u0623\u0639\u0636\u0627\u0621 \u0641\u0631\u064a\u0642 \u0627\u0644\u062f\u0639\u0645 \u0645\u062d\u0627\u062f\u062b\u062a\u0643 \u0647\u0646\u0627.",
    trustQuestion: "هل تريد دليلاً سريعًا عن طريقة عمل Kalderix؟ 😊",
    trustVerify: "بيانات السجل التجاري منشورة هنا: https://arbitrix.pro/business-registration\n\nوتوضح أن Kalderix تُدار بواسطة Arbitrix Trading، المسجّلة لدى غرفة التجارة الهولندية (KVK) برقم 72923513. يمكنك فتح شهادة التسجيل من تلك الصفحة.",
    trustCertificate: "شهادة التسجيل موجودة في الصفحة نفسها - افتح الشهادة لعرضها بحجم أكبر أو تنزيلها. لا أستطيع إرسال المستندات عبر هذه المحادثة، ولكن إذا كنت بحاجة إلى نسخة رسمية يمكن لفريقنا المساعدة - أرسل كلمة \"بشري\".",
    trustLimits: "ليس لديّ تفاصيل أكثر من ذلك غير ما هو منشور على صفحاتنا الرسمية، ولا أريد التخمين. إذا أردت، يمكنني أن أطلب من فريق الدعم مساعدتك - أرسل كلمة \"بشري\".",
    platformIntro: "Kalderix منصة أتمتة للمراجحة متعددة الأصول. تحدد فروق الأسعار للأصل نفسه بين المنصات المدعومة وتنفّذ الصفقات التي تستفيد من هذه الفروق تلقائيًا.",
    platformBullets: "• الوضع التجريبي: استكشف المنصة بأموال محاكاة - دون الحاجة إلى إيداع.\n• الوضع المباشر: تداول بأموال حقيقية بعد إيداع لا يقل عن 50 دولار.\n• الأتمتة: يشغّل البوت الاستراتيجية بدلاً منك، وتتابع النتائج في لوحة التحكم.",
    platformLink: "شاهد طريقة العمل مع فيديو توضيحي: https://arbitrix.pro/how-it-works",
    platformQuestion: "هل تريد معرفة كيفية البدء؟",
    earningsIntro: "تتفاوت عوائد التداول بحسب ظروف السوق وفرص المراجحة المتاحة. لا يوجد دخل يومي ثابت ولا أرباح مضمونة.",
    earningsVaries: "تحدد Kalderix الفرص بين المنصات المدعومة وتؤتمت التداول، لكن النتائج الفعلية قد تتفاوت. التداول ينطوي على مخاطر - يمكن أن تخسر المال وليس فقط أن تربح.",
    earningsDemo: "يمكنك استكشاف المنصة في الوضع التجريبي بأموال محاكاة قبل أن تقرر استخدام الوضع المباشر.",
    earningsQuestion: "هل تريد أن أوضح لك كيفية عمل المنصة؟",
    guideOfferQuestion: "هل تريد دليلاً سريعًا عن طريقة عمل Kalderix؟",
    withdrawChecked: "تمام! 😊 إذا كان السحب يظهر كمكتمل ووصلت الأموال فكل شيء على ما يرام. أما إذا كان لا يزال معلّقًا أو لم تستلم الأموال، فأخبرني وسأساعدك في معرفة الخطوة التالية.",
    withdrawArrived: "شكرًا لتأكيدك. يسعدني أن الأموال وصلت. إذا احتجت أي شيء آخر، أرسل رسالة هنا.",
    withdrawStillPending: "شكرًا لتحققك. عادةً ما تصل عمليات السحب خلال 15-30 دقيقة من الطلب. إذا كان سحبك لا يزال معلّقًا بعد ذلك، يمكنني تحويل الأمر إلى فريقنا - يمكنهم التحقق منه باستخدام المرجع من سجل معاملاتك.",
    btnBusiness: "📄 السجل التجاري",
    btnHowItWorks: "🎥 كيف تعمل Kalderix",
    withdrawTutorialLink: "درس السحب من Kalderix: {{url}}",
    onboardCreateAccount: "يمكنك إنشاء حسابك على موقع arbitrix.pro - لا يستغرق الأمر سوى دقيقة تقريبًا.",
    onboardRegisteredQuestion: "هل أنشأت حسابك في Kalderix بالفعل؟",
    onboardRegisteredYes: "رائع. هل أجريت إيداعك الأول بعد؟",
    onboardRegisteredNo: "لا مشكلة. يمكنك إنشاء حسابك على موقع Kalderix وتجربة الوضع التجريبي أولًا إن أردت. هل تريد المساعدة في إيداعك الأول؟",
    onboardDepositedQuestion: "هل أجريت إيداعك الأول بعد؟",
    onboardDepositedYes: "رائع. هل يظهر إيداعك في رصيد Live لديك الآن؟",
    onboardDepositedNo: "لا مشكلة - يمكنني إرشادك خلال الإيداع. هل لديك USDT (TRC20) بالفعل، أم تريد المساعدة في شرائه أولًا؟",
    partnerOffer: "يمكنني أيضًا إخبارك ببرنامج الشركاء لدينا: تكسب 20% من أول إيداع مؤهل لكل شخص تحيله - مكافأة لمرة واحدة، دون عمولة متكررة. هل تريد معرفة المزيد؟",
    partnerHow: "افتح قسم الإحالات في حسابك للعثور على رابط الإحالة والرمز الخاص بك. شاركهما مع من يريد تجربة Kalderix.",
    partnerDecline: "لا مشكلة. هل يمكنني مساعدتك في أي شيء آخر؟",
    help: [
      'دعم Kalderix',
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
      '/unlink - إلغاء ربط هذه المحادثة بحسابك في Kalderix'
    ].join('\n'),
      tutorialMenu: 'هذه هي الدروس المعتمدة. افتح الدرس الذي يناسب طريقة تمويل حسابك:',
      progressTitle: 'في هذه المحادثة حتى الآن:',
      progressWaiting: 'بانتظار:',
      progressMethod: 'طريقة الإيداع: {{method}}',
      progressEmpty: 'لا يوجد شيء قيد التنفيذ في هذه المحادثة بعد. اسألني عن الإيداع أو السحب أو برنامج الشركاء، أو اطلب موظف دعم بشري.',
      nextStepTitle: 'خطوتك التالية:',
      nextTopics: 'ماذا تريد أن تفعل بعد ذلك؟ أخبرني عن الإيداع أو السحب أو برنامج الشركاء، أو اطلب موظف دعم بشري.',
    acknowledgement: 'شكرًا لتواصلك مع دعم Kalderix. يُرجى وصف مشكلتك، وسيساعدك أحد موظفي الدعم هنا. يمكنك أيضًا استخدام /language لتغيير اللغة، أو /escalate لطلب التحدث مع موظف دعم بشري.',
    tutorialCaption: 'هل تفضّل المشاهدة؟ إليك شرحًا قصيرًا لعملية الإيداع.',
    escalationAck: 'تم تحويل طلبك إلى موظف دعم بشري. سيتابع معك أحد أعضاء فريق الدعم في هذه المحادثة.',
    textOnly: 'يُرجى إرسال رسالة نصية حتى يتمكن فريق الدعم من مساعدتك.',
    chatId: 'معرّف هذه المحادثة هو: {{id}}',
    subscribeSet: 'تم تسجيلك لتلقي تحديثات الشركاء في هذه المحادثة. أرسل /unsubscribe في أي وقت لإلغائها.',
    unsubscribeSet: 'تم إلغاء اشتراكك في تحديثات الشركاء. ردود الدعم في هذه المحادثة غير متأثرة.',
    subscribeUnavailable: 'تحديثات الشركاء غير متاحة الآن. محادثة الدعم الخاصة بك غير متأثرة.',
    linkSuccess: 'تم الارتباط. أصبحت هذه المحادثة مرتبطة بحسابك في Kalderix. استخدم /unlink في أي وقت لإلغاء الربط. الربط لا يشتركك في رسائل التسويق - أرسل /subscribe إذا كنت تريد تحديثات الشركاء.',
    linkAlready: 'هذه المحادثة مرتبطة بالفعل بحسابك في Kalderix. لم يتغير شيء.',
    linkInvalid: 'رابط الارتباط غير صالح أو انتهت صلاحيته. يرجى إنشاء رابط جديد من لوحة حسابك في Kalderix.',
    linkChatTaken: 'حساب تيليجرام هذا مرتبط بالفعل بحساب Kalderix آخر. أرسل /unlink لفصله أولاً، ثم أنشئ رابطاً جديداً من الحساب الصحيح.',
    linkAccountBusy: 'حسابك في Kalderix مرتبط بالفعل بمحادثة تيليجرام أخرى. افصل الربط من لوحة التحكم أولاً، ثم أنشئ رابطاً جديداً.',
    linkRateLimited: 'محاولات ارتباط كثيرة. يرجى الانتظار بضع دقائق والمحاولة مجدداً.',
    linkUnavailable: 'ربط الحساب غير متاح مؤقتاً. يرجى المحاولة لاحقاً.',
    unlinkRemoved: 'تم فصل الربط. لم تعد هذه المحادثة مرتبطة بحساب Kalderix.',
    unlinkNotLinked: 'هذه المحادثة غير مرتبطة بحساب Kalderix.',
    unlinkUnavailable: 'فصل الربط غير متاح مؤقتاً. يرجى المحاولة لاحقاً.',
    languagePrompt: 'اختر لغتك:\nيمكنك تغييرها في أي وقت بالأمر /language.',
    languageSet: 'تم تعيين اللغة إلى العربية. سأرد عليك بالعربية من الآن.',
    languageUnsupported: 'هذه اللغة غير متاحة بعد. سأستمر في الرد بـ{{language}}.',
    uncertain: 'لا توجد لديّ إجابة معتمدة على ذلك، ولا أرغب في التخمين. لقد أحلت الأمر إلى فريق الدعم لدينا، ويمكن لأحد الموظفين مساعدتك هنا.',
    humanHandoff: 'من الأفضل أن يتولى فريق الدعم لدينا هذه المسألة، وقد أحلت الأمر إلى موظف بشري. تابع هذه المحادثة وسيساعدك أحد أعضاء الفريق.',
    secretRefusal: 'لا يمكنني مشاركة أو تأكيد كلمات المرور أو المفاتيح الخاصة أو عبارات الاسترداد (seed) أو الرموز لمرة واحدة، ولن يطلب منك دعم Kalderix هذه البيانات أبدًا. لا تشاركها مع أي شخص. إذا كنت تواجه مشكلة في الوصول إلى حسابك، فاستخدم "نسيت كلمة المرور" أو اطلب المساعدة من موظف هنا.',
    secretShared: 'يُرجى عدم مشاركة كلمات المرور أو المفاتيح الخاصة أو عبارات الاسترداد (seed) أو الرموز لمرة واحدة هنا. من أجل سلامتك لم أُعِد كتابة ما أرسلته. إذا شاركت بيانات دخول، فغيّرها فورًا واطلب المساعدة من موظف لتأمين حسابك.',
    paymentStatus: 'ليس لديّ صلاحية الوصول إلى حسابك أو تفاصيل عملية الدفع، لذا لا يمكنني تأكيد حالة الإيداع أو السحب من هنا. لقد أحلت الأمر إلى فريق الدعم لدينا، ويمكنهم التحقق منه باستخدام رقم مرجع العملية.',
    aiDisabled: 'الردود الآلية متوقفة حاليًا. لقد حفظت رسالتك وسيساعدك أحد أعضاء فريق الدعم هنا.',
    promptForQuestion: 'يُرجى إرسال سؤالك كرسالة عادية وسيساعدك أحد موظفي الدعم هنا.',
    storageDegraded: 'لقد استلمنا رسالتك. نظام الدعم لدينا غير متاح مؤقتًا، لذلك قد يتأخر رد فريقنا أكثر من المعتاد.'
  }),
    zh: Object.freeze({
    greetingFresh: '\u60a8\u597d\uff01\u6211\u662f Kalderix \u5ba2\u670d\u52a9\u624b\u3002\u4eca\u5929\u6211\u80fd\u4e3a\u60a8\u505a\u4ec0\u4e48\uff1f',
    greetingAgain: '\u53c8\u89c1\u9762\u4e86\uff01\u6709\u4ec0\u4e48\u53ef\u4ee5\u5e2e\u60a8\u7684\u5417\uff1f',
    clarifyTopic: '\u62b1\u6b49\uff0c\u6211\u53ef\u80fd\u6ca1\u6709\u7406\u89e3\u60a8\u7684\u610f\u601d\u3002\u60a8\u662f\u60f3\u54a8\u8be2\u5165\u91d1\u3001\u5f00\u59cb\u4ea4\u6613\uff0c\u8fd8\u662f\u63d0\u73b0\uff1f',
    clarifyHelp: '\u6211\u53ef\u4ee5\u534f\u52a9\u60a8\u5904\u7406\u5165\u91d1\u3001\u63d0\u73b0\u3001\u4ea4\u6613\u3001\u9a8c\u8bc1\u3001\u63a8\u8350\u6216\u8d26\u6237\u95ee\u9898\u3002\u60a8\u9700\u8981\u54ea\u65b9\u9762\u7684\u5e2e\u52a9\uff1f',
    thanksClose: '\u4e0d\u5ba2\u6c14\uff01\u5982\u679c\u8fd8\u9700\u8981\u5176\u4ed6\u5e2e\u52a9\uff0c\u5728\u8fd9\u91cc\u7559\u8a00\u5373\u53ef\u3002',
    thanksOpen: '\u4e0d\u5ba2\u6c14\uff01\u6211\u4eec\u7ee7\u7eed\u521a\u624d\u7684\u8bdd\u9898\uff1a',
    ackNoQuestion: '\u660e\u767d\u4e86\u3002\u60a8\u9700\u8981\u54ea\u65b9\u9762\u7684\u5e2e\u52a9\uff1f',
    anythingElse: '\u8fd8\u6709\u4ec0\u4e48\u53ef\u4ee5\u5e2e\u60a8\u7684\u5417\uff1f',
    socialAck: '\u597d\u7684\uff01\u5982\u679c\u9700\u8981\u66f4\u591a\u5e2e\u52a9\uff0c\u8bf7\u544a\u8bc9\u6211\u3002',
    socialUnderstood: '\u597d\u7684\uff01\u5982\u6709\u4efb\u4f55\u7591\u95ee\uff0c\u8bf7\u544a\u8bc9\u6211\u3002',
    socialPositive: '\u5f88\u9ad8\u5174\u542c\u5230\u8fd9\u4e2a\u6d88\u606f\uff01\u8fd8\u6709\u4ec0\u4e48\u53ef\u4ee5\u5e2e\u60a8\u7684\u5417\uff1f',
    socialGreat: '\u592a\u597d\u4e86\uff01\u5982\u6709\u9700\u8981\uff0c\u968f\u65f6\u63d0\u95ee\u3002',
    socialThanks: '\u4e0d\u7528\u5ba2\u6c14\uff01\u5f88\u9ad8\u5174\u80fd\u5e2e\u4e0a\u5fd9\u3002',
    socialThanksBig: '\u4e0d\u7528\u8c22\uff01\u4efb\u4f55\u65f6\u5019\u9700\u8981\u5e2e\u52a9\uff0c\u6211\u4eec\u90fd\u5728\u3002',
    socialReciprocal: '\u968f\u65f6\u4e3a\u60a8\u670d\u52a1\uff01\u795d\u60a8\u6109\u5feb\u3002',
    socialClosing: '\u597d\u7684\u3002\u9700\u8981\u65f6\u968f\u65f6\u627e\u6211\u3002',
    reassure: '\u662f\u7684\uff0c\u6839\u636e\u6211\u638c\u63e1\u7684\u4fe1\u606f\uff0c\u8fd9\u662f\u6b63\u786e\u7684\u3002\u9700\u8981\u66f4\u8be6\u7ec6\u7684\u8bf4\u660e\u5417\uff1f',
    depositIntro: '\u6211\u53ef\u4ee5\u5e2e\u60a8\u3002\u60a8\u7684\u94b1\u5305\u91cc\u5df2\u7ecf\u6709 USDT (TRC20) \u5417\uff1f\u8fd8\u662f\u9700\u8981\u5148\u5e2e\u52a9\u60a8\u8d2d\u4e70\uff1f',
    depositWantHelpQuestion: '\u9700\u8981\u6211\u534f\u52a9\u60a8\u5b8c\u6210\u7b2c\u4e00\u7b14\u5165\u91d1\u5417\uff1f',
    depositNeedCrypto: '\u6ca1\u95ee\u9898\u2014\u2014\u60a8\u53ef\u4ee5\u901a\u8fc7\u53d7\u652f\u6301\u7684\u7b2c\u4e09\u65b9\u670d\u52a1\u8d2d\u4e70 USDT\uff0c\u7136\u540e\u53d1\u9001\u5230\u60a8\u7684 Kalderix \u5165\u91d1\u5730\u5740\u3002\u53ef\u7528\u6027\u3001\u652f\u4ed8\u65b9\u5f0f\u548c\u624b\u7eed\u8d39\u53d6\u51b3\u4e8e\u60a8\u6240\u5728\u7684\u56fd\u5bb6/\u5730\u533a\u548c\u670d\u52a1\u5546\u3002',
    depositHaveCrypto: '\u597d\u7684\u3002\u8bf7\u5728\u5e94\u7528\u4e2d\u6253\u5f00\u5165\u91d1\uff0c\u8f93\u5165\u91d1\u989d\uff0c\u7136\u540e\u901a\u8fc7 TRON (TRC20) \u7f51\u7edc\u5c06 USDT \u53d1\u9001\u5230\u663e\u793a\u7684\u51c6\u786e\u5730\u5740\u3002\u7f51\u7edc\u786e\u8ba4\u540e\uff0c\u5165\u91d1\u4f1a\u88ab\u81ea\u52a8\u68c0\u6d4b\u3002',
    depositMethodPrompt: '\u60a8\u60f3\u89c2\u770b\u54ea\u79cd\u65b9\u5f0f\u7684\u6559\u7a0b\uff1aPaybis\u3001Transak \u8fd8\u662f Trust Wallet\uff1f',
    depositMethodPromptAgain: '\u8bf7\u544a\u8bc9\u6211\u60a8\u60f3\u4f7f\u7528\u54ea\u79cd\u65b9\u5f0f\uff1aPaybis\u3001Transak \u6216 Trust Wallet\u3002',
    depositTutorialLink: '{{method}} \u5165\u91d1\u6559\u7a0b\uff1a{{url}}',
    tutorialHow: '\u8bf7\u6253\u5f00\u4e0a\u9762\u7684\u6559\u7a0b\u94fe\u63a5\uff0c\u6309\u60a8\u9009\u62e9\u7684\u65b9\u5f0f\u64cd\u4f5c\u3002\u5982\u679c\u67d0\u4e00\u6b65\u4e0d\u6e05\u695a\uff0c\u8bf7\u544a\u8bc9\u6211\u662f\u54ea\u4e00\u6b65\uff0c\u6211\u6765\u89e3\u91ca\u3002',
    depositTutorialFollowUp: '\u8bf7\u6309\u6559\u7a0b\u64cd\u4f5c\uff0c\u5982\u679c\u9047\u5230\u4efb\u4f55\u56f0\u96be\u8bf7\u544a\u8bc9\u6211\u3002',
    depositAfterAck: '\u597d\u7684\u3002\u8d44\u91d1\u53d1\u9001\u540e\uff0c\u8bf7\u56de\u590d\u201c\u5df2\u5b8c\u6210\u201d\uff0c\u6211\u4f1a\u6307\u5bfc\u60a8\u4e0b\u4e00\u6b65\u3002',
    depositCompletedAskTransfer: '\u592a\u597d\u4e86\uff01\u60a8\u662f\u5426\u5df2\u6210\u529f\u5c06\u8d44\u91d1\u8f6c\u5165\u60a8\u7684 Kalderix \u5165\u91d1\u5730\u5740\uff1f',
    depositTransferNo: '\u6ca1\u5173\u7cfb\uff0c\u8bf7\u6162\u6162\u6765\u3002\u51c6\u5907\u597d\u540e\u6211\u968f\u65f6\u5728\u8fd9\u91cc\u3002\u9700\u8981\u518d\u770b\u4e00\u6b21 {{method}} \u6559\u7a0b\u5417\uff1f',
    depositTransferNoGeneric: '\u6ca1\u5173\u7cfb\uff0c\u8bf7\u6162\u6162\u6765\u3002\u51c6\u5907\u597d\u540e\u6211\u968f\u65f6\u5728\u8fd9\u91cc\u3002\u9700\u8981\u518d\u770b\u4e00\u6b21\u5165\u91d1\u6559\u7a0b\u5417\uff1f',
    depositTransferYes: '\u597d\u7684\u3002\u7f51\u7edc\u786e\u8ba4\u540e\uff0c\u5165\u91d1\u901a\u5e38\u4f1a\u88ab\u81ea\u52a8\u68c0\u6d4b\u3002\u73b0\u5728\u60a8\u7684 Live \u4f59\u989d\u4e2d\u80fd\u770b\u5230\u8fd9\u7b14\u5165\u91d1\u4e86\u5417\uff1f',
    depositCreditedQuestion: '\u73b0\u5728\u60a8\u7684 Live \u4f59\u989d\u4e2d\u80fd\u770b\u5230\u8fd9\u7b14\u5165\u91d1\u4e86\u5417\uff1f',
    depositCreditedYes: '\u597d\u7684\u3002\u5982\u679c\u5165\u91d1\u5df2\u663e\u793a\u5728\u60a8\u7684 Live \u4f59\u989d\u4e2d\uff0c\u60a8\u5c31\u53ef\u4ee5\u5728\u5b9e\u76d8\u6a21\u5f0f\u4ea4\u6613\u4e86\u3002\u5982\u679c\u8fd8\u6ca1\u6709\u663e\u793a\uff0c\u8bf7\u56de\u590d\u201c\u4eba\u5de5\u201d\uff0c\u6211\u4eec\u7684\u56e2\u961f\u4f1a\u4e3a\u60a8\u6838\u67e5\u3002',
    depositCreditedNo: '\u611f\u8c22\u60a8\u67e5\u770b\u3002\u5165\u91d1\u901a\u5e38\u4f1a\u5728\u51e0\u5206\u949f\u5185\u786e\u8ba4\u3002\u8bf7\u4fdd\u7559\u53d1\u7968\u7f16\u53f7\uff0c\u5e76\u4e14\u4e0d\u8981\u91cd\u590d\u4ed8\u6b3e\u3002\u5982\u679c\u4ecd\u672a\u663e\u793a\uff0c\u8bf7\u56de\u590d\u201c\u4eba\u5de5\u201d\uff0c\u6211\u4eec\u7684\u56e2\u961f\u4f1a\u4e3a\u60a8\u6838\u67e5\u3002',
    withdrawIntro: '\u6211\u53ef\u4ee5\u534f\u52a9\u60a8\u5904\u7406\u63d0\u73b0\u3002\u60a8\u53ef\u4ee5\u4ece Live \u4f59\u989d\u53d1\u8d77\u63d0\u73b0\u5230\u60a8\u7684\u94b1\u5305\u5730\u5740\uff0c\u5904\u7406\u671f\u95f4\u4f1a\u5728\u8bb0\u5f55\u4e2d\u663e\u793a\u4e3a\u5f85\u5904\u7406\u3002',
    withdrawTiming: '\u63d0\u73b0\u901a\u5e38\u4f1a\u5728 15-30 \u5206\u949f\u5185\u5230\u8d26\u3002\u60a8\u53ef\u4ee5\u5728\u4ea4\u6613\u8bb0\u5f55\u4e2d\u67e5\u770b\u72b6\u6001\u3002',
    withdrawHelpPrompt: '\u9700\u8981\u6211\u5e2e\u60a8\u5904\u7406\u67d0\u4e2a\u5177\u4f53\u7684\u63d0\u73b0\u95ee\u9898\u5417\uff1f',
    trustIntro: '\u8fd9\u662f\u4e2a\u597d\u95ee\u9898\uff01\u5728\u5f00\u59cb\u4e4b\u524d\u591a\u4e86\u89e3\u4e00\u4e2a\u5e73\u53f0\u603b\u662f\u597d\u4e8b\u3002',
    trustWhatWeDo: 'Kalderix \u662f\u4e00\u5bb6\u6ce8\u518c\u4f01\u4e1a\uff0c\u8fd0\u8425\u81ea\u52a8\u5316\u591a\u8d44\u4ea7\u5957\u5229\u5e73\u53f0\uff0c\u7528\u4e8e\u8bc6\u522b\u53d7\u652f\u6301\u4ea4\u6613\u6240\u4e4b\u95f4\u4ef7\u683c\u5dee\u5f02\u5e26\u6765\u7684\u4ea4\u6613\u673a\u4f1a\u3002',
    trustExploreIntro: '\u60a8\u53ef\u4ee5\u4e86\u89e3\u4ee5\u4e0b\u5185\u5bb9\uff1a',
    trustPoints: '\u2705 \u6ce8\u518c\u4f01\u4e1a\uff1aKalderix \u62e5\u6709\u53ef\u4f9b\u67e5\u770b\u548c\u6838\u5b9e\u7684\u5b98\u65b9\u5de5\u5546\u767b\u8bb0\u4fe1\u606f\u3002\n\u2705 \u8bd5\u7528\u6f14\u793a\u6a21\u5f0f\uff1a\u5728\u5207\u6362\u5230\u5b9e\u76d8\u6a21\u5f0f\u524d\uff0c\u7528\u6a21\u62df\u8d44\u91d1\u4e86\u89e3\u5e73\u53f0\u8fd0\u4f5c\u3002\n\u2705 \u4e86\u89e3\u8fd0\u4f5c\u65b9\u5f0f\uff1a\u6211\u4eec\u63d0\u4f9b\u8bf4\u660e\u548c\u89c6\u9891\u6559\u7a0b\uff0c\u5e2e\u52a9\u60a8\u719f\u6089\u5e73\u53f0\u3002\n\u2705 \u8f7b\u677e\u4e0a\u624b\uff1a\u6211\u4eec\u7684\u652f\u6301\u56e2\u961f\u53ef\u4ee5\u6307\u5bfc\u60a8\u5b8c\u6210\u6ce8\u518c\u3001\u5165\u91d1\u548c\u5e73\u53f0\u64cd\u4f5c\u3002',
    trustLinksIntro: '\u60a8\u53ef\u4ee5\u5728\u8fd9\u91cc\u67e5\u770b\u6211\u4eec\u7684\u5b98\u65b9\u9875\u9762\uff1a',
    trustLinks: '\ud83d\udcc4 \u5de5\u5546\u767b\u8bb0\u4fe1\u606f\uff1a\nhttps://arbitrix.pro/business-registration\n\n\ud83c\udfa5 Kalderix \u5982\u4f55\u8fd0\u4f5c\uff1a\nhttps://arbitrix.pro/how-it-works',
    trustClose: '\u6211\u4eec\u5f88\u4e50\u610f\u5e2e\u60a8\u4e86\u89e3\u5168\u90e8\u5185\u5bb9\u5e76\u719f\u6089\u5e73\u53f0\u3002',
    trustSupportLine: '\u60a8\u4e5f\u53ef\u4ee5\u968f\u65f6\u56de\u590d\u201c\u4eba\u5de5\u201d\uff0c\u6211\u4eec\u7684\u652f\u6301\u56e2\u961f\u6210\u5458\u4f1a\u5728\u8fd9\u91cc\u63a5\u624b\u3002',
    trustQuestion: '\u9700\u8981\u4e00\u4efd\u5173\u4e8e Kalderix \u8fd0\u4f5c\u65b9\u5f0f\u7684\u5feb\u901f\u6307\u5357\u5417\uff1f',
    trustVerify: '\u6211\u4eec\u7684\u767b\u8bb0\u4fe1\u606f\u53d1\u5e03\u5728\u8fd9\u91cc\uff1ahttps://arbitrix.pro/business-registration\n\n\u5176\u4e2d\u663e\u793a Kalderix \u7531 Arbitrix Trading \u8fd0\u8425\uff0c\u8be5\u516c\u53f8\u5728\u8377\u5170\u5546\u4f1a\uff08KVK\uff09\u6ce8\u518c\uff0cKVK \u7f16\u53f7\u4e3a 72923513\u3002\u60a8\u53ef\u4ee5\u5728\u8be5\u9875\u9762\u6253\u5f00\u6ce8\u518c\u8bc1\u4e66\u3002',
    trustCertificate: '\u6ce8\u518c\u8bc1\u4e66\u5c31\u5728\u540c\u4e00\u9875\u9762\u2014\u2014\u6253\u5f00\u5373\u53ef\u67e5\u770b\u5168\u5c3a\u5bf8\u6216\u4e0b\u8f7d\u3002\u6211\u65e0\u6cd5\u901a\u8fc7\u6b64\u804a\u5929\u53d1\u9001\u6587\u4ef6\uff0c\u4f46\u5982\u679c\u60a8\u9700\u8981\u6b63\u5f0f\u526f\u672c\uff0c\u6211\u4eec\u7684\u56e2\u961f\u53ef\u4ee5\u534f\u52a9\u2014\u2014\u8bf7\u56de\u590d\u201c\u4eba\u5de5\u201d\u3002',
    trustLimits: '\u9664\u4e86\u5b98\u65b9\u9875\u9762\u516c\u5e03\u7684\u4fe1\u606f\u4e4b\u5916\uff0c\u6211\u6ca1\u6709\u66f4\u591a\u7ec6\u8282\uff0c\u4e5f\u4e0d\u60f3\u731c\u6d4b\u3002\u5982\u679c\u60a8\u613f\u610f\uff0c\u6211\u53ef\u4ee5\u8bf7\u652f\u6301\u56e2\u961f\u534f\u52a9\u2014\u2014\u8bf7\u56de\u590d\u201c\u4eba\u5de5\u201d\u3002',
    platformIntro: 'Kalderix \u662f\u4e00\u4e2a\u81ea\u52a8\u5316\u591a\u8d44\u4ea7\u5957\u5229\u5e73\u53f0\u3002\u5b83\u8bc6\u522b\u540c\u4e00\u8d44\u4ea7\u5728\u53d7\u652f\u6301\u4ea4\u6613\u6240\u4e4b\u95f4\u7684\u4ef7\u683c\u5dee\u5f02\uff0c\u5e76\u81ea\u52a8\u6267\u884c\u5229\u7528\u8fd9\u4e9b\u5dee\u5f02\u7684\u4ea4\u6613\u3002',
    platformBullets: '\u2022 \u6f14\u793a\u6a21\u5f0f\uff1a\u7528\u6a21\u62df\u8d44\u91d1\u4f53\u9a8c\u5e73\u53f0\uff0c\u65e0\u9700\u5165\u91d1\u3002\n\u2022 \u5b9e\u76d8\u6a21\u5f0f\uff1a\u5165\u91d1\u81f3\u5c11 $50 \u540e\u4f7f\u7528\u771f\u5b9e\u8d44\u91d1\u4ea4\u6613\u3002\n\u2022 \u81ea\u52a8\u5316\uff1a\u673a\u5668\u4eba\u66ff\u60a8\u6267\u884c\u7b56\u7565\uff0c\u60a8\u5728\u4eea\u8868\u76d8\u67e5\u770b\u7ed3\u679c\u3002',
    platformLink: '\u89c2\u770b\u89c6\u9891\u4e86\u89e3\u8fd0\u4f5c\u65b9\u5f0f\uff1ahttps://arbitrix.pro/how-it-works',
    platformQuestion: '\u60f3\u4e86\u89e3\u5982\u4f55\u5f00\u59cb\u5417\uff1f',
    earningsIntro: '\u4ea4\u6613\u6536\u76ca\u53d6\u51b3\u4e8e\u5e02\u573a\u72b6\u51b5\u548c\u53ef\u7528\u7684\u5957\u5229\u673a\u4f1a\u3002\u4e0d\u5b58\u5728\u56fa\u5b9a\u65e5\u6536\u76ca\uff0c\u4e5f\u4e0d\u4fdd\u8bc1\u76c8\u5229\u3002',
    earningsVaries: 'Kalderix \u5728\u53d7\u652f\u6301\u4ea4\u6613\u6240\u4e4b\u95f4\u8bc6\u522b\u673a\u4f1a\u5e76\u81ea\u52a8\u4ea4\u6613\uff0c\u4f46\u5b9e\u9645\u7ed3\u679c\u53ef\u80fd\u6709\u5dee\u5f02\u3002\u4ea4\u6613\u6709\u98ce\u9669\u2014\u2014\u60a8\u53ef\u80fd\u4e8f\u635f\uff0c\u800c\u4e0d\u53ea\u662f\u76c8\u5229\u3002',
    earningsDemo: '\u5728\u51b3\u5b9a\u662f\u5426\u4f7f\u7528\u5b9e\u76d8\u6a21\u5f0f\u4e4b\u524d\uff0c\u60a8\u53ef\u4ee5\u5148\u7528\u6a21\u62df\u8d44\u91d1\u5728\u6f14\u793a\u6a21\u5f0f\u4e2d\u4f53\u9a8c\u5e73\u53f0\u3002',
    earningsQuestion: '\u9700\u8981\u6211\u4e3a\u60a8\u8bf4\u660e\u5e73\u53f0\u5982\u4f55\u8fd0\u4f5c\u5417\uff1f',
    guideOfferQuestion: '\u9700\u8981\u4e00\u4efd\u5173\u4e8e Kalderix \u8fd0\u4f5c\u65b9\u5f0f\u7684\u5feb\u901f\u6307\u5357\u5417\uff1f',
    withdrawChecked: '\u597d\u7684\uff01\u5982\u679c\u60a8\u7684\u63d0\u73b0\u5df2\u663e\u793a\u5b8c\u6210\u4e14\u8d44\u91d1\u5df2\u5230\u8d26\uff0c\u90a3\u5c31\u6ca1\u95ee\u9898\u4e86\u3002\u5982\u679c\u4ecd\u5728\u5904\u7406\u4e2d\u6216\u60a8\u5c1a\u672a\u6536\u5230\u8d44\u91d1\uff0c\u8bf7\u544a\u8bc9\u6211\uff0c\u6211\u4f1a\u534f\u52a9\u60a8\u67e5\u770b\u4e0b\u4e00\u6b65\u3002',
    withdrawArrived: '\u611f\u8c22\u786e\u8ba4\u3002\u5f88\u9ad8\u5174\u8d44\u91d1\u5df2\u5230\u8d26\u3002\u5982\u679c\u8fd8\u6709\u5176\u4ed6\u95ee\u9898\uff0c\u5728\u8fd9\u91cc\u7559\u8a00\u5373\u53ef\u3002',
    withdrawStillPending: '\u611f\u8c22\u60a8\u67e5\u770b\u3002\u63d0\u73b0\u901a\u5e38\u5728\u7533\u8bf7\u540e 15-30 \u5206\u949f\u5185\u5230\u8d26\u3002\u5982\u679c\u4e4b\u540e\u4ecd\u5728\u5904\u7406\u4e2d\uff0c\u6211\u53ef\u4ee5\u8f6c\u4ea4\u6211\u4eec\u7684\u56e2\u961f\u2014\u2014\u4ed6\u4eec\u53ef\u4ee5\u6839\u636e\u60a8\u8bb0\u5f55\u4e2d\u7684\u7f16\u53f7\u8fdb\u884c\u6838\u67e5\u3002',
    btnBusiness: '\ud83d\udcc4 \u5de5\u5546\u767b\u8bb0\u4fe1\u606f',
    btnHowItWorks: '\ud83c\udfa5 Kalderix \u5982\u4f55\u8fd0\u4f5c',
    withdrawTutorialLink: 'Kalderix \u63d0\u73b0\u6559\u7a0b\uff1a{{url}}',
    onboardCreateAccount: '\u60a8\u53ef\u4ee5\u5728 arbitrix.pro \u7f51\u7ad9\u4e0a\u521b\u5efa\u8d26\u6237\u2014\u2014\u5927\u7ea6\u53ea\u9700\u4e00\u5206\u949f\u3002',
    onboardRegisteredQuestion: '\u60a8\u5df2\u7ecf\u521b\u5efa Kalderix \u8d26\u6237\u4e86\u5417\uff1f',
    onboardRegisteredYes: '\u597d\u7684\u3002\u60a8\u5df2\u7ecf\u5b8c\u6210\u7b2c\u4e00\u7b14\u5165\u91d1\u4e86\u5417\uff1f',
    onboardRegisteredNo: '\u6ca1\u95ee\u9898\u3002\u60a8\u53ef\u4ee5\u5728 Kalderix \u7f51\u7ad9\u521b\u5efa\u8d26\u6237\uff0c\u4e5f\u53ef\u4ee5\u5148\u4f53\u9a8c\u6f14\u793a\u6a21\u5f0f\u3002\u9700\u8981\u6211\u534f\u52a9\u60a8\u5b8c\u6210\u7b2c\u4e00\u7b14\u5165\u91d1\u5417\uff1f',
    onboardDepositedQuestion: '\u60a8\u5df2\u7ecf\u5b8c\u6210\u7b2c\u4e00\u7b14\u5165\u91d1\u4e86\u5417\uff1f',
    onboardDepositedYes: '\u597d\u7684\u3002\u73b0\u5728\u60a8\u7684 Live \u4f59\u989d\u4e2d\u80fd\u770b\u5230\u8fd9\u7b14\u5165\u91d1\u4e86\u5417\uff1f',
    onboardDepositedNo: '\u6ca1\u95ee\u9898\u2014\u2014\u6211\u53ef\u4ee5\u6307\u5bfc\u60a8\u5b8c\u6210\u5165\u91d1\u3002\u60a8\u5df2\u7ecf\u6709 USDT (TRC20) \u5417\uff1f\u8fd8\u662f\u9700\u8981\u5148\u5e2e\u52a9\u60a8\u8d2d\u4e70\uff1f',
    partnerOffer: '\u6211\u4e5f\u53ef\u4ee5\u4e3a\u60a8\u4ecb\u7ecd\u5408\u4f5c\u4f19\u4f34\u8ba1\u5212\uff1a\u6bcf\u63a8\u8350\u4e00\u4f4d\u7528\u6237\uff0c\u60a8\u53ef\u83b7\u5f97\u5176\u9996\u7b14\u7b26\u5408\u6761\u4ef6\u7684\u5165\u91d1\u7684 20%\u2014\u2014\u4e00\u6b21\u6027\u5956\u52b1\uff0c\u6ca1\u6709\u6301\u7eed\u6027\u4f63\u91d1\u3002\u60f3\u4e86\u89e3\u66f4\u591a\u5417\uff1f',
    partnerHow: '\u5728\u8d26\u6237\u4e2d\u6253\u5f00\u201c\u63a8\u8350\u201d\u90e8\u5206\uff0c\u5373\u53ef\u627e\u5230\u60a8\u7684\u63a8\u8350\u94fe\u63a5\u548c\u63a8\u8350\u7801\u3002\u628a\u5b83\u4eec\u5206\u4eab\u7ed9\u60f3\u8bd5\u7528 Kalderix \u7684\u4eba\u3002',
    partnerDecline: '\u6ca1\u95ee\u9898\u3002\u8fd8\u6709\u4ec0\u4e48\u53ef\u4ee5\u5e2e\u60a8\u7684\u5417\uff1f',
    help: [
        'Kalderix \u5ba2\u670d',
        '',
        '\u8bf7\u50cf\u5e73\u5e38\u4e00\u6837\u53d1\u9001\u60a8\u7684\u95ee\u9898\uff0c\u5ba2\u670d\u4eba\u5458\u4f1a\u5728\u8fd9\u91cc\u56de\u590d\u60a8\u3002',
        '/language - \u66f4\u6539\u60a8\u7684\u8bed\u8a00',
        '/escalate - \u8bf7\u6c42\u4eba\u5de5\u5ba2\u670d',
        '/subscribe - \u5728\u6b64\u804a\u5929\u63a5\u6536\u5408\u4f5c\u4f19\u4f34\u52a8\u6001',
        '/unsubscribe - \u505c\u6b62\u63a5\u6536\u5408\u4f5c\u4f19\u4f34\u52a8\u6001',
        '/tutorial - \u6253\u5f00\u5165\u91d1\u548c\u63d0\u73b0\u6559\u7a0b',
        '/progress - \u67e5\u770b\u60a8\u5728\u6b64\u804a\u5929\u4e2d\u7684\u8fdb\u5ea6',
        '/next - \u4e0b\u4e00\u6b65\u8be5\u505a\u4ec0\u4e48',
        '/chatid - \u663e\u793a\u6b64\u804a\u5929\u7684 ID',
        '/unlink - \u5c06\u6b64\u804a\u5929\u4e0e\u60a8\u7684 Kalderix \u8d26\u6237\u89e3\u9664\u5173\u8054',
    ].join('\n'),
    tutorialMenu: '\u4ee5\u4e0b\u662f\u5df2\u6279\u51c6\u7684\u6559\u7a0b\u3002\u8bf7\u6253\u5f00\u4e0e\u60a8\u5165\u91d1\u65b9\u5f0f\u76f8\u5bf9\u5e94\u7684\u6559\u7a0b\uff1a',
    progressTitle: '\u6b64\u804a\u5929\u76ee\u524d\u7684\u8fdb\u5ea6\uff1a',
    progressWaiting: '\u7b49\u5f85\u4e2d\uff1a',
    progressMethod: '\u5165\u91d1\u65b9\u5f0f\uff1a{{method}}',
    progressEmpty: '\u6b64\u804a\u5929\u4e2d\u76ee\u524d\u8fd8\u6ca1\u6709\u8fdb\u884c\u4e2d\u7684\u4e8b\u9879\u3002\u60a8\u53ef\u4ee5\u8be2\u95ee\u5165\u91d1\u3001\u63d0\u73b0\u3001\u5408\u4f5c\u4f19\u4f34\u8ba1\u5212\uff0c\u6216\u8981\u6c42\u8f6c\u63a5\u4eba\u5de5\u3002',
    nextStepTitle: '\u60a8\u7684\u4e0b\u4e00\u6b65\uff1a',
    nextTopics: '\u63a5\u4e0b\u6765\u60a8\u60f3\u505a\u4ec0\u4e48\uff1f\u53ef\u4ee5\u54a8\u8be2\u5165\u91d1\u3001\u63d0\u73b0\u3001\u5408\u4f5c\u4f19\u4f34\u8ba1\u5212\uff0c\u6216\u8981\u6c42\u8f6c\u63a5\u4eba\u5de5\u3002',
    acknowledgement: '\u611f\u8c22\u60a8\u8054\u7cfb Kalderix \u5ba2\u670d\u3002\u8bf7\u63cf\u8ff0\u60a8\u7684\u95ee\u9898\uff0c\u5ba2\u670d\u4eba\u5458\u4f1a\u5728\u8fd9\u91cc\u4e3a\u60a8\u63d0\u4f9b\u5e2e\u52a9\u3002\u60a8\u4e5f\u53ef\u4ee5\u4f7f\u7528 /language \u66f4\u6539\u8bed\u8a00\uff0c\u6216\u4f7f\u7528 /escalate \u8bf7\u6c42\u4eba\u5de5\u5ba2\u670d\u3002',
    tutorialCaption: '\u66f4\u559c\u6b22\u770b\u89c6\u9891\uff1f\u8fd9\u91cc\u6709\u4e00\u6bb5\u7b80\u77ed\u7684\u5165\u91d1\u6d41\u7a0b\u6f14\u793a\u3002',
    escalationAck: '\u60a8\u7684\u8bf7\u6c42\u5df2\u8f6c\u4ea4\u4eba\u5de5\u5ba2\u670d\u3002\u652f\u6301\u56e2\u961f\u6210\u5458\u4f1a\u5728\u6b64\u804a\u5929\u4e2d\u4e0e\u60a8\u8054\u7cfb\u3002',
    textOnly: '\u8bf7\u53d1\u9001\u6587\u5b57\u6d88\u606f\uff0c\u4ee5\u4fbf\u6211\u4eec\u7684\u652f\u6301\u56e2\u961f\u4e3a\u60a8\u63d0\u4f9b\u5e2e\u52a9\u3002',
    chatId: '\u6b64\u804a\u5929\u7684 ID \u662f\uff1a{{id}}',
    subscribeSet: '\u60a8\u5df2\u8ba2\u9605\u6b64\u804a\u5929\u4e2d\u7684\u5408\u4f5c\u4f19\u4f34\u52a8\u6001\u3002\u968f\u65f6\u53d1\u9001 /unsubscribe \u5373\u53ef\u505c\u6b62\u63a5\u6536\u3002',
    unsubscribeSet: '\u60a8\u5df2\u53d6\u6d88\u8ba2\u9605\u5408\u4f5c\u4f19\u4f34\u52a8\u6001\u3002\u6b64\u804a\u5929\u4e2d\u7684\u5ba2\u670d\u56de\u590d\u4e0d\u53d7\u5f71\u54cd\u3002',
    subscribeUnavailable: '\u5408\u4f5c\u4f19\u4f34\u52a8\u6001\u76ee\u524d\u4e0d\u53ef\u7528\u3002\u60a8\u7684\u5ba2\u670d\u5bf9\u8bdd\u4e0d\u53d7\u5f71\u54cd\u3002',
    linkSuccess: '\u5df2\u8fde\u63a5\u3002\u6b64\u804a\u5929\u73b0\u5df2\u5173\u8054\u5230\u60a8\u7684 Kalderix \u8d26\u6237\u3002\u968f\u65f6\u4f7f\u7528 /unlink \u53ef\u89e3\u9664\u5173\u8054\u3002\u5173\u8054\u5e76\u4e0d\u4f1a\u8ba9\u60a8\u8ba2\u9605\u8425\u9500\u6d88\u606f\u2014\u2014\u5982\u679c\u60f3\u63a5\u6536\u5408\u4f5c\u4f19\u4f34\u52a8\u6001\uff0c\u8bf7\u53d1\u9001 /subscribe\u3002',
    linkAlready: '\u6b64\u804a\u5929\u5df2\u5173\u8054\u5230\u60a8\u7684 Kalderix \u8d26\u6237\uff0c\u672a\u505a\u4efb\u4f55\u66f4\u6539\u3002',
    linkInvalid: '\u8be5\u8fde\u63a5\u94fe\u63a5\u65e0\u6548\u6216\u5df2\u8fc7\u671f\u3002\u8bf7\u4ece\u60a8\u7684 Kalderix \u4eea\u8868\u76d8\u521b\u5efa\u65b0\u7684\u94fe\u63a5\u3002',
    linkChatTaken: '\u6b64 Telegram \u8d26\u6237\u5df2\u8fde\u63a5\u5230\u53e6\u4e00\u4e2a Kalderix \u8d26\u6237\u3002\u8bf7\u5148\u53d1\u9001 /unlink \u89e3\u9664\u5173\u8054\uff0c\u7136\u540e\u4ece\u6b63\u786e\u7684\u8d26\u6237\u521b\u5efa\u65b0\u94fe\u63a5\u3002',
    linkAccountBusy: '\u60a8\u7684 Kalderix \u8d26\u6237\u5df2\u8fde\u63a5\u5230\u53e6\u4e00\u4e2a Telegram \u804a\u5929\u3002\u8bf7\u5148\u5728\u4eea\u8868\u76d8\u4e2d\u89e3\u9664\u5173\u8054\uff0c\u7136\u540e\u521b\u5efa\u65b0\u94fe\u63a5\u3002',
    linkRateLimited: '\u8fde\u63a5\u5c1d\u8bd5\u6b21\u6570\u8fc7\u591a\u3002\u8bf7\u7b49\u5f85\u51e0\u5206\u949f\u540e\u91cd\u8bd5\u3002',
    linkUnavailable: '\u8d26\u6237\u5173\u8054\u6682\u65f6\u4e0d\u53ef\u7528\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
    unlinkRemoved: '\u5df2\u89e3\u9664\u5173\u8054\u3002\u6b64\u804a\u5929\u4e0d\u518d\u4e0e\u4efb\u4f55 Kalderix \u8d26\u6237\u5173\u8054\u3002',
    unlinkNotLinked: '\u6b64\u804a\u5929\u672a\u5173\u8054\u4efb\u4f55 Kalderix \u8d26\u6237\u3002',
    unlinkUnavailable: '\u89e3\u9664\u5173\u8054\u6682\u65f6\u4e0d\u53ef\u7528\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002',
    languagePrompt: '\u8bf7\u9009\u62e9\u60a8\u7684\u8bed\u8a00\uff1a\n\u60a8\u968f\u65f6\u53ef\u4ee5\u7528 /language \u66f4\u6539\u3002',
    languageSet: '\u8bed\u8a00\u5df2\u8bbe\u7f6e\u4e3a\u7b80\u4f53\u4e2d\u6587\u3002\u4ece\u73b0\u5728\u8d77\u6211\u5c06\u4f7f\u7528\u7b80\u4f53\u4e2d\u6587\u56de\u590d\u3002',
    languageUnsupported: '\u8be5\u8bed\u8a00\u6682\u4e0d\u652f\u6301\u3002\u6211\u5c06\u7ee7\u7eed\u4f7f\u7528{{language}}\u56de\u590d\u3002',
    uncertain: '\u6211\u8fd8\u6ca1\u6709\u9488\u5bf9\u6b64\u95ee\u9898\u7684\u5df2\u6279\u51c6\u7b54\u590d\uff0c\u4e5f\u4e0d\u60f3\u731c\u6d4b\u3002\u6211\u5df2\u5c06\u5176\u6807\u8bb0\u7ed9\u652f\u6301\u56e2\u961f\u2014\u2014\u4eba\u5de5\u5ba2\u670d\u53ef\u4ee5\u5728\u8fd9\u91cc\u5e2e\u52a9\u60a8\u3002',
    humanHandoff: '\u8fd9\u66f4\u9002\u5408\u7531\u6211\u4eec\u7684\u652f\u6301\u56e2\u961f\u5904\u7406\uff0c\u56e0\u6b64\u6211\u5df2\u8f6c\u4ea4\u4eba\u5de5\u5ba2\u670d\u3002\u8bf7\u7559\u610f\u6b64\u804a\u5929\uff0c\u56e2\u961f\u6210\u5458\u4f1a\u4e3a\u60a8\u63d0\u4f9b\u5e2e\u52a9\u3002',
    secretRefusal: '\u6211\u65e0\u6cd5\u63d0\u4f9b\u6216\u786e\u8ba4\u5bc6\u7801\u3001\u79c1\u94a5\u3001\u52a9\u8bb0\u8bcd\u6216\u4e00\u6b21\u6027\u9a8c\u8bc1\u7801\uff0cKalderix \u5ba2\u670d\u4e5f\u7edd\u4e0d\u4f1a\u5411\u60a8\u7d22\u8981\u8fd9\u4e9b\u4fe1\u606f\u3002\u8bf7\u4e0d\u8981\u5411\u4efb\u4f55\u4eba\u900f\u9732\u3002\u5982\u679c\u9047\u5230\u8d26\u6237\u8bbf\u95ee\u95ee\u9898\uff0c\u8bf7\u4f7f\u7528\u201c\u5fd8\u8bb0\u5bc6\u7801\u201d\u6216\u5728\u6b64\u8981\u6c42\u8f6c\u63a5\u4eba\u5de5\u3002',
    secretShared: '\u8bf7\u52ff\u5728\u6b64\u5206\u4eab\u5bc6\u7801\u3001\u79c1\u94a5\u3001\u52a9\u8bb0\u8bcd\u6216\u4e00\u6b21\u6027\u9a8c\u8bc1\u7801\u3002\u4e3a\u60a8\u7684\u5b89\u5168\u8d77\u89c1\uff0c\u6211\u6ca1\u6709\u91cd\u590d\u8fd9\u4e9b\u5185\u5bb9\u3002\u5982\u679c\u60a8\u5df2\u7ecf\u5206\u4eab\u8fc7\u51ed\u636e\uff0c\u8bf7\u7acb\u5373\u66f4\u6539\uff0c\u5e76\u5728\u9700\u8981\u4fdd\u62a4\u8d26\u6237\u65f6\u8981\u6c42\u8f6c\u63a5\u4eba\u5de5\u3002',
    paymentStatus: '\u6211\u65e0\u6cd5\u8bbf\u95ee\u60a8\u7684\u8d26\u6237\u6216\u4ed8\u6b3e\u8be6\u60c5\uff0c\u56e0\u6b64\u65e0\u6cd5\u5728\u6b64\u786e\u8ba4\u5165\u91d1\u6216\u63d0\u73b0\u7684\u72b6\u6001\u3002\u6211\u5df2\u8f6c\u4ea4\u652f\u6301\u56e2\u961f\uff0c\u4ed6\u4eec\u53ef\u4ee5\u4f7f\u7528\u60a8\u7684\u4ea4\u6613\u7f16\u53f7\u8fdb\u884c\u6838\u67e5\u3002',
    aiDisabled: '\u81ea\u52a8\u56de\u590d\u76ee\u524d\u5df2\u5173\u95ed\u3002\u6211\u5df2\u4fdd\u5b58\u60a8\u7684\u6d88\u606f\uff0c\u652f\u6301\u56e2\u961f\u6210\u5458\u4f1a\u5728\u8fd9\u91cc\u4e3a\u60a8\u63d0\u4f9b\u5e2e\u52a9\u3002',
    promptForQuestion: '\u8bf7\u50cf\u5e73\u5e38\u4e00\u6837\u53d1\u9001\u60a8\u7684\u95ee\u9898\uff0c\u5ba2\u670d\u4eba\u5458\u4f1a\u5728\u8fd9\u91cc\u4e3a\u60a8\u63d0\u4f9b\u5e2e\u52a9\u3002',
    storageDegraded: '\u6211\u4eec\u5df2\u6536\u5230\u60a8\u7684\u6d88\u606f\u3002\u5ba2\u670d\u7cfb\u7edf\u6682\u65f6\u4e0d\u53ef\u7528\uff0c\u56e0\u6b64\u6211\u4eec\u7684\u56e2\u961f\u53ef\u80fd\u9700\u8981\u6bd4\u5e73\u65f6\u66f4\u957f\u7684\u65f6\u95f4\u624d\u80fd\u56de\u590d\u3002'
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
