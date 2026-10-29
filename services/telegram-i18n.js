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
    help: [
      'Arbitrix Support',
      '',
      'Send your question as a normal message and a support agent will reply here.',
      '/language - change your language',
      '/escalate - request a human agent',
      '/subscribe - partner updates in this chat',
      '/unsubscribe - stop partner updates',
      '/chatid - show this chat ID',
      '/unlink - disconnect this chat from your Arbitrix account'
    ].join('\n'),
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
    help: [
      'Suporte Arbitrix',
      '',
      'Envie sua pergunta como uma mensagem normal e um agente de suporte responderá aqui.',
      '/language - alterar o idioma',
      '/escalate - solicitar atendimento humano',
      '/subscribe - novidades para parceiros neste chat',
      '/unsubscribe - cancelar novidades de parceiro',
      '/chatid - mostrar o ID desta conversa',
      '/unlink - desvincular esta conversa da sua conta Arbitrix'
    ].join('\n'),
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
    help: [
      'دعم Arbitrix',
      '',
      'أرسل سؤالك كرسالة عادية وسيرد عليك أحد موظفي الدعم هنا.',
      '/language - تغيير اللغة',
      '/escalate - طلب موظف دعم بشري',
      '/subscribe - تحديثات الشركاء في هذه المحادثة',
      '/unsubscribe - إلغاء تحديثات الشركاء',
      '/chatid - عرض معرّف هذه المحادثة',
      '/unlink - إلغاء ربط هذه المحادثة بحسابك في Arbitrix'
    ].join('\n'),
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
