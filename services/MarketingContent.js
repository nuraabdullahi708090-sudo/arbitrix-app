'use strict';

/**
 * Approved Telegram marketing copy (en / pt / ar).
 *
 * WHY THIS MODULE EXISTS
 * The marketing publisher must never generate financial claims. Every template
 * here is static, human-approved text with only CONFIGURED business facts
 * interpolated (minimum deposit, referral percentage, promotional credit). There
 * is no model, no random generation and no second copy of the business rules:
 * the numbers arrive from server.js constants and referral_config.
 *
 * BUSINESS FACTS USED (verified in server.js / referral_config):
 *   - minimum qualifying deposit: 100
 *   - referral reward: 20% of the referred user's FIRST qualifying deposit, once
 *   - no recurring / lifetime commission
 *   - $50 promotional credit exists (tradable, not withdrawable)
 * The withdrawal minimum is deliberately ABSENT from every template, because it
 * is disclosed only inside the withdrawal flow.
 *
 * LINKS
 * URLs are supplied by configuration. Nothing is invented: if a URL is missing
 * the line and the button are simply omitted.
 */

const LOCALES = Object.freeze(['en', 'pt', 'ar']);
const DEFAULT_LOCALE = 'en';
const ARROW = '\u2192';
// Telegram's own first_name limit, reused as the greeting-name cap.
const GREETING_NAME_MAX = 64;
const WEEKLY_THEMES = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const LABELS = {
  en: {
    greeting: '👋 Welcome to the Arbitrix Partners Community, {{name}}!',
    greetingAnon: '👋 Welcome to the Arbitrix Partners Community!',
    support: 'Customer support',
    partnerSupport: 'Partner payment support',
    announcements: 'Official announcements',
    register: 'Create your account',
    channel: 'Official channel',
    learnHowItWorks: '🎓 Learn how it works:',
    openRegister: '👉',
    supportLine: '💬 Customer support:',
    partnerSupportLine: '💳 Partner payment support:',
    buttons: {
      register: '🚀 Create Account',
      howItWorks: '🎓 How It Works',
      support: '💬 Customer Support',
      partnerSupport: '💳 Partner Payment Support'
    },
    // The approved wording: the member logs in and opens the Referral page. It
    // never suggests that a personal link is sent to them automatically.
    referralIntro: 'After registering, log into your account and open the Referral page. There, you\'ll find your personal referral link and code.',
    referralSteps: [
      'Log in to your Arbitrix account.',
      'Open your account dashboard.',
      'Scroll down to the Referral section.',
      'Copy the link and share it with the people you invite.'
    ],
    referralReminder: "Can't find your referral link? Scroll down your account dashboard to locate the Referral section."
  },
  pt: {
    greeting: '👋 Boas-vindas à Comunidade de Parceiros Arbitrix, {{name}}!',
    greetingAnon: '👋 Boas-vindas à Comunidade de Parceiros Arbitrix!',
    support: 'Suporte ao cliente',
    partnerSupport: 'Suporte de pagamentos a parceiros',
    announcements: 'Avisos oficiais',
    register: 'Criar sua conta',
    channel: 'Canal oficial',
    learnHowItWorks: '🎓 Veja como funciona:',
    openRegister: '👉',
    supportLine: '💬 Suporte ao cliente:',
    partnerSupportLine: '💳 Suporte de pagamentos a parceiros:',
    buttons: {
      register: '🚀 Criar conta',
      howItWorks: '🎓 Como funciona',
      support: '💬 Suporte ao cliente',
      partnerSupport: '💳 Suporte de pagamentos a parceiros'
    },
    referralIntro: 'Depois do cadastro, entre na sua conta e abra a seção Indicações. Ali você encontra seu link de indicação pessoal e seu código de indicação.',
    referralSteps: [
      'Entre na sua conta Arbitrix.',
      'Abra o painel da sua conta.',
      'Role a página para baixo até a seção Indicações.',
      'Copie o link e compartilhe com as pessoas que você convidar.'
    ],
    referralReminder: 'Não encontrou seu link de indicação? Role o painel da sua conta para baixo até a seção Indicações.'
  },
  ar: {
    greeting: '👋 مرحبًا بك في مجتمع شركاء Arbitrix، {{name}}!',
    greetingAnon: '👋 مرحبًا بك في مجتمع شركاء Arbitrix!',
    support: 'دعم العملاء',
    partnerSupport: 'دعم مدفوعات الشركاء',
    announcements: 'الإعلانات الرسمية',
    register: 'أنشئ حسابك',
    channel: 'القناة الرسمية',
    learnHowItWorks: '🎓 تعرّف على كيفية العمل:',
    openRegister: '👉',
    supportLine: '💬 دعم العملاء:',
    partnerSupportLine: '💳 دعم مدفوعات الشركاء:',
    buttons: {
      register: '🚀 إنشاء حساب',
      howItWorks: '🎓 كيف يعمل',
      support: '💬 دعم العملاء',
      partnerSupport: '💳 دعم مدفوعات الشركاء'
    },
    referralIntro: 'بعد إنشاء الحساب، سجّل الدخول إلى حسابك وافتح قسم الإحالات. ستجد هناك رابط الإحالة الخاص بك ورمز الإحالة.',
    referralSteps: [
      'سجّل الدخول إلى حسابك في Arbitrix.',
      'افتح لوحة تحكم حسابك.',
      'مرّر إلى الأسفل حتى قسم الإحالات.',
      'انسخ الرابط وشاركه مع الأشخاص الذين تدعوهم.'
    ],
    referralReminder: 'لم تجد رابط الإحالة الخاص بك؟ مرّر لوحة تحكم حسابك إلى الأسفل للوصول إلى قسم الإحالات.'
  }
};

const EN = {
  welcome: [
    '{{greeting}}',
    '',
    'We\'re happy to have you here! 🎉',
    '',
    'Arbitrix is an automated multi-asset arbitrage platform designed to identify price differences for the same instruments across different trading venues.',
    '',
    'Whether you\'re here to explore the platform, learn how it works, or grow through referrals, we\'re here to help you get started.',
    '',
    '🚀 YOUR NEXT STEPS',
    '',
    '1️⃣ EXPLORE ARBITRIX',
    '',
    'Discover how the platform works and explore Demo Mode using virtual funds before funding a live account.',
    '',
    '{{learnLine}}',
    '',
    '2️⃣ CREATE YOUR ACCOUNT',
    '',
    'Ready to get started? Create your account here:',
    '',
    '{{createLine}}',
    '',
    '3️⃣ DISCOVER THE PARTNER PROGRAMME',
    '',
    'Want to introduce others to Arbitrix?',
    '',
    '{{referralIntro}}',
    '',
    '🎁 REFERRAL REWARD',
    '',
    'Earn a one-time reward equal to {{referralPercent}}% of a referred user\'s first qualifying deposit of ${{minDeposit}} or more.',
    '',
    '💬 NEED HELP?',
    '',
    'Our support team is here to assist you with getting started, using the platform, and understanding the Partner Programme.',
    '',
    'Choose the appropriate support option below whenever you need assistance.',
    '',
    '👇 Choose an option below to get started!',
  ].join('\n'),

  startHere: [
    '📌 START HERE',
    '',
    '👋 Welcome to the Arbitrix Partners Community!',
    '',
    'Arbitrix is an automated multi-asset arbitrage platform that identifies price differences for the same instruments across different trading venues.',
    '',
    '🚀 YOUR NEXT STEPS',
    '',
    '1️⃣ EXPLORE ARBITRIX',
    'Discover how the platform works and explore Demo Mode using virtual funds before funding a live account.',
    '',
    '{{learnLine}}',
    '',
    '2️⃣ CREATE YOUR ACCOUNT',
    'Ready to get started? Create your account here:',
    '',
    '{{createLine}}',
    '',
    '3️⃣ DISCOVER THE PARTNER PROGRAMME',
    'Want to introduce others to Arbitrix?',
    '{{referralIntro}}',
    '',
    '{{referralSteps}}',
    '',
    '{{referralReminder}}',
    '',
    '4️⃣ REFERRAL REWARD',
    'Earn a one-time reward equal to {{referralPercent}}% of a referred user\'s first qualifying deposit of ${{minDeposit}} or more.',
    '',
    '🤝 PROMOTE RESPONSIBLY',
    'Describe what the platform does. Never promise profits, and never describe trading as risk-free.',
    '',
    '💬 NEED HELP?',
    'Our support team is here to assist you with getting started, using the platform, and understanding the Partner Programme.',
    '',
    '{{supportLine}}',
    '{{partnerSupportLine}}',
    '',
    '👇 Choose an option below to get started!',
  ].join('\n'),

  channelIntro: [
    'Welcome to the official Arbitrix channel.',
    '',
    'What Arbitrix does',
    'Automated multi-asset arbitrage: it watches price differences for the same instrument across venues and records the result of each execution in the account.',
    '',
    'Demo Mode and Live Mode',
    'Demo Mode uses virtual funds to explore the platform. Live Mode uses your own deposited funds; the minimum deposit is ${{minDeposit}}.',
    '',
    'What is published here',
    'Product announcements, educational posts and partner resources. Nothing else is an official announcement.',
    '',
    'Partner resources',
    'After registering, open the Referral page for your personal link and code. You earn {{referralPercent}}% of a referred user\'s first qualifying deposit (minimum ${{minDeposit}}), once. There is no recurring commission.',
    '',
    'Assistance',
    '{{links}}',
    '',
    'Trading involves risk and profits are not guaranteed. Nothing published here is financial advice.'
  ].join('\n'),

  weekly: {
    mon: [
      'PARTNER PROGRAMME - HOW IT WORKS',
      '',
      '1. Register and open the Referral page.',
      '2. Share your personal link or code.',
      '3. When your referred user makes their first qualifying deposit of at least ${{minDeposit}}, you earn {{referralPercent}}% of it.',
      '4. The reward is paid once. There is no recurring or lifetime commission.',
      '5. Track rewards and request a payout from the partner area of your dashboard.',
      '',
      'Promote only to people who understand that trading carries risk.',
      '',
      '{{links}}'
    ].join('\n'),

    tue: [
      'HOW TO DESCRIBE ARBITRIX ACCURATELY',
      '',
      'Say this:',
      '- Arbitrix is automated arbitrage software that records each execution in the user\'s account.',
      '- Demo Mode uses virtual funds.',
      '- The referral reward is {{referralPercent}}% of a referred user\'s first qualifying deposit (minimum ${{minDeposit}}), paid once.',
      '',
      'Never promise guaranteed profit, never describe trading as risk-free,',
      'never mention passive income, and never claim a lifetime or recurring commission.',
      'Do not publish figures about earnings that you cannot verify.',
      '',
      'Use the official material so your audience sees the same facts we publish.',
      '',
      '{{links}}'
    ].join('\n'),

    wed: [
      'COMMON QUESTIONS',
      '',
      'Is Demo Mode real money? No. It uses virtual funds.',
      'What is the minimum deposit for Live? ${{minDeposit}}.',
      'Where is my referral link? On the Referral page after you register.',
      'How much is the referral reward? {{referralPercent}}% of your referred user\'s first qualifying deposit (minimum ${{minDeposit}}).',
      'Does the commission repeat? No. It is paid once.',
      'Where do I get help? Use the support contacts below.',
      '',
      '{{links}}'
    ].join('\n'),

    thu: [
      'WHAT ARBITRAGE MEANS HERE',
      '',
      'The same instrument can trade at slightly different prices on different venues. Arbitrage is the practice of capturing that difference.',
      '',
      'Arbitrix automates the process: it compares prices, executes the position and records the result in the account.',
      '',
      'A spread can close before execution, and a result can be a loss. The platform does not predict the market and does not guarantee profit.',
      '',
      'Demo Mode is the safest way to see how the process works before using your own funds.',
      '',
      '{{links}}'
    ].join('\n'),

    fri: [
      'PARTNER CHECKLIST FOR THIS WEEK',
      '',
      '1. Open the Referral page and copy your link.',
      '2. Check that your code still works.',
      '3. Share it with people who already understand trading risk.',
      '4. Read the promotion guidance before you post.',
      '5. Check the partner area for reward and payout status.',
      '',
      'Do not promise returns and do not use another person\'s results as your own.',
      '',
      '{{links}}'
    ].join('\n'),

    sat: [
      'STAYING SAFE WITH ARBITRIX',
      '',
      '- Official announcements come from this channel only.',
      '- Support never asks for your password, private keys, seed phrase or one-time codes.',
      '- We never ask you to send funds to a personal wallet.',
      '- We never promise guaranteed profit.',
      '- Check the address before you sign in.',
      '',
      'If something looks wrong, contact support before you act.',
      '',
      '{{links}}'
    ].join('\n'),

    sun: [
      'WEEKLY RECAP',
      '',
      'This week: the partner programme, how to describe Arbitrix accurately, common questions, what arbitrage means here, and staying safe.',
      '',
      'Start here: register, then open the Referral page for your link.',
      'Reward: {{referralPercent}}% of a referred user\'s first qualifying deposit (minimum ${{minDeposit}}), paid once.',
      '',
      'Trading involves risk and profits are not guaranteed.',
      '',
      '{{links}}'
    ].join('\n')
  }
};

const PT = {
  welcome: [
    '{{greeting}}',
    '',
    'Que bom ter você aqui! 🎉',
    '',
    'A Arbitrix é uma plataforma automatizada de arbitragem multi-ativo, criada para identificar diferenças de preço do mesmo instrumento em diferentes corretoras.',
    '',
    'Seja para conhecer a plataforma, entender como ela funciona ou crescer com indicações, estamos aqui para ajudar você a começar.',
    '',
    '🚀 SEUS PRÓXIMOS PASSOS',
    '',
    '1️⃣ CONHEÇA A ARBITRIX',
    '',
    'Veja como a plataforma funciona e explore o Modo Demo com fundos virtuais antes de depositar em uma conta real.',
    '',
    '{{learnLine}}',
    '',
    '2️⃣ CRIE SUA CONTA',
    '',
    'Pronto para começar? Crie sua conta aqui:',
    '',
    '{{createLine}}',
    '',
    '3️⃣ CONHEÇA O PROGRAMA DE PARCEIROS',
    '',
    'Quer apresentar a Arbitrix para outras pessoas?',
    '',
    '{{referralIntro}}',
    '',
    '🎁 RECOMPENSA DE INDICAÇÃO',
    '',
    'Receba uma recompensa única equivalente a {{referralPercent}}% do primeiro depósito qualificado do seu indicado, de ${{minDeposit}} ou mais.',
    '',
    '💬 PRECISA DE AJUDA?',
    '',
    'Nossa equipe de suporte está disponível para ajudar você a começar, usar a plataforma e entender o Programa de Parceiros.',
    '',
    'Escolha a opção de suporte adequada abaixo sempre que precisar.',
    '',
    '👇 Escolha uma opção abaixo para começar!',
  ].join('\n'),

  startHere: [
    '📌 COMECE AQUI',
    '',
    '👋 Boas-vindas à Comunidade de Parceiros Arbitrix!',
    '',
    'A Arbitrix é uma plataforma automatizada de arbitragem multi-ativo que identifica diferenças de preço do mesmo instrumento em diferentes corretoras.',
    '',
    '🚀 SEUS PRÓXIMOS PASSOS',
    '',
    '1️⃣ CONHEÇA A ARBITRIX',
    'Veja como a plataforma funciona e explore o Modo Demo com fundos virtuais antes de depositar em uma conta real.',
    '',
    '{{learnLine}}',
    '',
    '2️⃣ CRIE SUA CONTA',
    'Pronto para começar? Crie sua conta aqui:',
    '',
    '{{createLine}}',
    '',
    '3️⃣ CONHEÇA O PROGRAMA DE PARCEIROS',
    'Quer apresentar a Arbitrix para outras pessoas?',
    '{{referralIntro}}',
    '',
    '{{referralSteps}}',
    '',
    '{{referralReminder}}',
    '',
    '4️⃣ RECOMPENSA DE INDICAÇÃO',
    'Receba uma recompensa única equivalente a {{referralPercent}}% do primeiro depósito qualificado do seu indicado, de ${{minDeposit}} ou mais.',
    '',
    '🤝 DIVULGUE COM RESPONSABILIDADE',
    'Descreva o que a plataforma faz. Nunca prometa lucros e nunca diga que negociar não tem risco.',
    '',
    '💬 PRECISA DE AJUDA?',
    'Nossa equipe de suporte está disponível para ajudar você a começar, usar a plataforma e entender o Programa de Parceiros.',
    '',
    '{{supportLine}}',
    '{{partnerSupportLine}}',
    '',
    '👇 Escolha uma opção abaixo para começar!',
  ].join('\n'),

  channelIntro: [
    'Bem-vindo ao canal oficial da Arbitrix.',
    '',
    'O que a Arbitrix faz',
    'Arbitragem multi-ativo automatizada: acompanha diferenças de preço do mesmo instrumento em corretoras diferentes e registra o resultado de cada execução na conta.',
    '',
    'Modo Demo e Modo Live',
    'O Modo Demo usa fundos virtuais para explorar a plataforma. O Modo Live usa os seus próprios fundos depositados; o depósito mínimo é ${{minDeposit}}.',
    '',
    'O que é publicado aqui',
    'Avisos de produto, conteúdo educativo e materiais para parceiros. Nada além disso é um aviso oficial.',
    '',
    'Recursos para parceiros',
    'Depois de se registrar, abra a página de Indicações para obter seu link e código. Você recebe {{referralPercent}}% do primeiro depósito qualificado do seu indicado (mínimo ${{minDeposit}}), uma única vez. Não existe comissão recorrente.',
    '',
    'Assistência',
    '{{links}}',
    '',
    'Negociar envolve risco e os lucros não são garantidos. Nada publicado aqui é aconselhamento financeiro.'
  ].join('\n'),

  weekly: {
    mon: [
      'PROGRAMA DE PARCEIROS - COMO FUNCIONA',
      '',
      '1. Registre-se e abra a página de Indicações.',
      '2. Compartilhe seu link ou código pessoal.',
      '3. Quando seu indicado fizer o primeiro depósito qualificado de pelo menos ${{minDeposit}}, você recebe {{referralPercent}}% desse valor.',
      '4. A recompensa é paga uma única vez. Não existe comissão recorrente ou vitalícia.',
      '5. Acompanhe as recompensas e solicite o pagamento na área de parceiro do painel.',
      '',
      'Divulgue apenas para pessoas que entendem que negociar envolve risco.',
      '',
      '{{links}}'
    ].join('\n'),

    tue: [
      'COMO DESCREVER A ARBITRIX COM PRECISÃO',
      '',
      'Diga isto:',
      '- A Arbitrix é um software automatizado de arbitragem que registra cada execução na conta do usuário.',
      '- O Modo Demo usa fundos virtuais.',
      '- A recompensa de indicação é {{referralPercent}}% do primeiro depósito qualificado do indicado (mínimo ${{minDeposit}}), paga uma única vez.',
      '',
      'Nunca prometa lucro garantido, nunca diga que negociar não tem risco,',
      'nunca mencione renda passiva e nunca fale em comissão vitalícia ou recorrente.',
      'Não publique números de ganhos que você não possa comprovar.',
      '',
      'Use o material oficial para que seu público veja os mesmos fatos que publicamos.',
      '',
      '{{links}}'
    ].join('\n'),

    wed: [
      'PERGUNTAS FREQUENTES',
      '',
      'O Modo Demo é dinheiro real? Não. Ele usa fundos virtuais.',
      'Qual é o depósito mínimo para o Live? ${{minDeposit}}.',
      'Onde está meu link de indicação? Na página de Indicações após o registro.',
      'Quanto é a recompensa de indicação? {{referralPercent}}% do primeiro depósito qualificado do indicado (mínimo ${{minDeposit}}).',
      'A comissão se repete? Não. É paga uma única vez.',
      'Onde obtenho ajuda? Use os contatos de suporte abaixo.',
      '',
      '{{links}}'
    ].join('\n'),

    thu: [
      'O QUE SIGNIFICA ARBITRAGEM AQUI',
      '',
      'O mesmo instrumento pode ser negociado a preços ligeiramente diferentes em corretoras diferentes. Arbitragem é a prática de capturar essa diferença.',
      '',
      'A Arbitrix automatiza o processo: compara preços, executa a posição e registra o resultado na conta.',
      '',
      'Um spread pode fechar antes da execução, e um resultado pode ser prejuízo. A plataforma não prevê o mercado e não garante lucro.',
      '',
      'O Modo Demo é a forma mais segura de ver como o processo funciona antes de usar seus próprios fundos.',
      '',
      '{{links}}'
    ].join('\n'),

    fri: [
      'CHECKLIST DO PARCEIRO PARA ESTA SEMANA',
      '',
      '1. Abra a página de Indicações e copie seu link.',
      '2. Verifique se o seu código ainda funciona.',
      '3. Compartilhe com pessoas que já entendem o risco de negociar.',
      '4. Leia as orientações de divulgação antes de publicar.',
      '5. Confira a área de parceiro para ver recompensas e pagamentos.',
      '',
      'Não prometa retornos e não use o resultado de outra pessoa como se fosse seu.',
      '',
      '{{links}}'
    ].join('\n'),

    sat: [
      'SEGURANÇA NA ARBITRIX',
      '',
      '- Os avisos oficiais vêm apenas deste canal.',
      '- O suporte nunca pede sua senha, chaves privadas, frase de recuperação ou códigos de uso único.',
      '- Nunca pedimos que você envie fundos para uma carteira pessoal.',
      '- Nunca prometemos lucro garantido.',
      '- Confira o endereço antes de entrar.',
      '',
      'Se algo parecer errado, fale com o suporte antes de agir.',
      '',
      '{{links}}'
    ].join('\n'),

    sun: [
      'RESUMO DA SEMANA',
      '',
      'Esta semana: o programa de parceiros, como descrever a Arbitrix com precisão, perguntas frequentes, o que significa arbitragem aqui e segurança.',
      '',
      'Comece aqui: registre-se e abra a página de Indicações para pegar seu link.',
      'Recompensa: {{referralPercent}}% do primeiro depósito qualificado do indicado (mínimo ${{minDeposit}}), paga uma única vez.',
      '',
      'Negociar envolve risco e os lucros não são garantidos.',
      '',
      '{{links}}'
    ].join('\n')
  }
};

const AR = {
  welcome: [
    '{{greeting}}',
    '',
    'يسعدنا وجودك معنا! 🎉',
    '',
    'Arbitrix منصة آلية متعددة الأصول للمراجحة، صُممت لتحديد فروق الأسعار للأداة نفسها بين منصات التداول المختلفة.',
    '',
    'سواء كنت هنا لاستكشاف المنصة، أو لمعرفة كيف تعمل، أو لتنمية أعمالك عبر الإحالات، فنحن هنا لمساعدتك على البدء.',
    '',
    '🚀 خطواتك التالية',
    '',
    '1️⃣ استكشف Arbitrix',
    '',
    'تعرّف على كيفية عمل المنصة واستكشف الوضع التجريبي بأموال افتراضية قبل تمويل حساب حقيقي.',
    '',
    '{{learnLine}}',
    '',
    '2️⃣ أنشئ حسابك',
    '',
    'هل أنت مستعد للبدء؟ أنشئ حسابك هنا:',
    '',
    '{{createLine}}',
    '',
    '3️⃣ تعرّف على برنامج الشركاء',
    '',
    'هل ترغب في تعريف الآخرين بـ Arbitrix؟',
    '',
    '{{referralIntro}}',
    '',
    '🎁 مكافأة الإحالة',
    '',
    'احصل على مكافأة لمرة واحدة تعادل {{referralPercent}}% من أول إيداع مؤهل للمستخدم الذي أحلت إليه بقيمة ${{minDeposit}} أو أكثر.',
    '',
    '💬 تحتاج إلى مساعدة؟',
    '',
    'فريق الدعم لدينا جاهز لمساعدتك على البدء واستخدام المنصة وفهم برنامج الشركاء.',
    '',
    'اختر خيار الدعم المناسب أدناه متى احتجت إلى المساعدة.',
    '',
    '👇 اختر أحد الخيارات أدناه للبدء!',
  ].join('\n'),

  startHere: [
    '📌 ابدأ من هنا',
    '',
    '👋 مرحبًا بك في مجتمع شركاء Arbitrix!',
    '',
    'Arbitrix منصة آلية متعددة الأصول للمراجحة تحدد فروق الأسعار للأداة نفسها بين منصات التداول المختلفة.',
    '',
    '🚀 خطواتك التالية',
    '',
    '1️⃣ استكشف Arbitrix',
    'تعرّف على كيفية عمل المنصة واستكشف الوضع التجريبي بأموال افتراضية قبل تمويل حساب حقيقي.',
    '',
    '{{learnLine}}',
    '',
    '2️⃣ أنشئ حسابك',
    'هل أنت مستعد للبدء؟ أنشئ حسابك هنا:',
    '',
    '{{createLine}}',
    '',
    '3️⃣ تعرّف على برنامج الشركاء',
    'هل ترغب في تعريف الآخرين بـ Arbitrix؟',
    '{{referralIntro}}',
    '',
    '{{referralSteps}}',
    '',
    '{{referralReminder}}',
    '',
    '4️⃣ مكافأة الإحالة',
    'احصل على مكافأة لمرة واحدة تعادل {{referralPercent}}% من أول إيداع مؤهل للمستخدم الذي أحلت إليه بقيمة ${{minDeposit}} أو أكثر.',
    '',
    '🤝 رَوّج بمسؤولية',
    'اشرح ما تفعله المنصة. لا تعد بأرباح، ولا تصف التداول أبدًا بأنه بلا مخاطر.',
    '',
    '💬 تحتاج إلى مساعدة؟',
    'فريق الدعم لدينا جاهز لمساعدتك على البدء واستخدام المنصة وفهم برنامج الشركاء.',
    '',
    '{{supportLine}}',
    '{{partnerSupportLine}}',
    '',
    '👇 اختر أحد الخيارات أدناه للبدء!',
  ].join('\n'),

  channelIntro: [
    'مرحبًا بك في القناة الرسمية لـ Arbitrix.',
    '',
    'ماذا تفعل Arbitrix',
    'مراجحة آلية متعددة الأصول: تتابع فروق الأسعار للأداة نفسها في منصات مختلفة، وتسجل نتيجة كل تنفيذ في الحساب.',
    '',
    'الوضع التجريبي والوضع الحقيقي',
    'يستخدم الوضع التجريبي أموالًا افتراضية لاستكشاف المنصة. ويستخدم الوضع الحقيقي أموالك المودعة؛ والحد الأدنى للإيداع هو ${{minDeposit}}.',
    '',
    'ما يُنشر هنا',
    'إعلانات المنتج والمحتوى التعليمي ومواد الشركاء. ولا يُعد أي شيء آخر إعلانًا رسميًا.',
    '',
    'مواد الشركاء',
    'بعد التسجيل، افتح صفحة الإحالات للحصول على رابطك ورمزك. تحصل على {{referralPercent}}% من أول إيداع مؤهل للمستخدم الذي أحلت إليه (بحد أدنى ${{minDeposit}})، مرة واحدة. لا توجد عمولة متكررة.',
    '',
    'المساعدة',
    '{{links}}',
    '',
    'التداول ينطوي على مخاطر والأرباح غير مضمونة. لا شيء يُنشر هنا يُعد نصيحة مالية.'
  ].join('\n'),

  weekly: {
    mon: [
      'برنامج الشركاء - كيف يعمل',
      '',
      '1. سجّل وافتح صفحة الإحالات.',
      '2. شارك رابطك أو رمزك الشخصي.',
      '3. عندما يقوم المستخدم الذي أحلت إليه بأول إيداع مؤهل لا يقل عن ${{minDeposit}}، تحصل على {{referralPercent}}% منه.',
      '4. تُدفع المكافأة مرة واحدة. لا توجد عمولة متكررة أو مدى الحياة.',
      '5. تابع المكافآت واطلب الدفع من منطقة الشريك في لوحة التحكم.',
      '',
      'رَوّج فقط لأشخاص يدركون أن التداول ينطوي على مخاطر.',
      '',
      '{{links}}'
    ].join('\n'),

    tue: [
      'كيف تصف Arbitrix بدقة',
      '',
      'قل هذا:',
      '- Arbitrix برنامج مراجحة آلي يسجل كل تنفيذ في حساب المستخدم.',
      '- الوضع التجريبي يستخدم أموالًا افتراضية.',
      '- مكافأة الإحالة هي {{referralPercent}}% من أول إيداع مؤهل للمستخدم الذي أحلت إليه (بحد أدنى ${{minDeposit}})، وتُدفع مرة واحدة.',
      '',
      'لا تعد أبدًا بأرباح مضمونة، ولا تصف التداول بأنه بلا مخاطر،',
      'ولا تذكر الدخل السلبي، ولا تتحدث عن عمولة مدى الحياة أو متكررة.',
      'لا تنشر أرقام أرباح لا يمكنك إثباتها.',
      '',
      'استخدم المواد الرسمية ليرى جمهورك الحقائق نفسها التي ننشرها.',
      '',
      '{{links}}'
    ].join('\n'),

    wed: [
      'أسئلة شائعة',
      '',
      'هل الوضع التجريبي أموال حقيقية؟ لا. يستخدم أموالًا افتراضية.',
      'ما الحد الأدنى للإيداع في الوضع الحقيقي؟ ${{minDeposit}}.',
      'أين رابط الإحالة؟ في صفحة الإحالات بعد التسجيل.',
      'كم مكافأة الإحالة؟ {{referralPercent}}% من أول إيداع مؤهل للمستخدم الذي أحلت إليه (بحد أدنى ${{minDeposit}}).',
      'هل تتكرر العمولة؟ لا. تُدفع مرة واحدة.',
      'من أين أحصل على المساعدة؟ استخدم جهات الدعم أدناه.',
      '',
      '{{links}}'
    ].join('\n'),

    thu: [
      'ماذا تعني المراجحة هنا',
      '',
      'قد تُتداول الأداة نفسها بأسعار مختلفة قليلًا في منصات مختلفة. والمراجحة هي الاستفادة من هذا الفرق.',
      '',
      'تقوم Arbitrix بأتمتة العملية: تقارن الأسعار، وتنفذ الصفقة، وتسجل النتيجة في الحساب.',
      '',
      'قد يُغلق الفرق قبل التنفيذ، وقد تكون النتيجة خسارة. لا تتنبأ المنصة بالسوق ولا تضمن الربح.',
      '',
      'الوضع التجريبي هو الطريقة الأكثر أمانًا لرؤية كيفية عمل العملية قبل استخدام أموالك.',
      '',
      '{{links}}'
    ].join('\n'),

    fri: [
      'قائمة الشريك لهذا الأسبوع',
      '',
      '1. افتح صفحة الإحالات وانسخ رابطك.',
      '2. تأكد أن رمزك لا يزال يعمل.',
      '3. شاركه مع أشخاص يدركون مخاطر التداول.',
      '4. اقرأ إرشادات الترويج قبل النشر.',
      '5. راجع منطقة الشريك لمعرفة حالة المكافآت والمدفوعات.',
      '',
      'لا تعد بعوائد، ولا تستخدم نتائج شخص آخر على أنها نتائجك.',
      '',
      '{{links}}'
    ].join('\n'),

    sat: [
      'السلامة مع Arbitrix',
      '',
      '- الإعلانات الرسمية تصدر من هذه القناة فقط.',
      '- الدعم لا يطلب أبدًا كلمة المرور أو المفاتيح الخاصة أو عبارة الاسترداد أو الرموز لمرة واحدة.',
      '- لا نطلب أبدًا إرسال الأموال إلى محفظة شخصية.',
      '- لا نعد أبدًا بأرباح مضمونة.',
      '- تحقق من العنوان قبل تسجيل الدخول.',
      '',
      'إذا بدا شيء ما غير صحيح، فتواصل مع الدعم قبل أن تتصرف.',
      '',
      '{{links}}'
    ].join('\n'),

    sun: [
      'ملخص الأسبوع',
      '',
      'هذا الأسبوع: برنامج الشركاء، وكيف تصف Arbitrix بدقة، والأسئلة الشائعة، وماذا تعني المراجحة هنا، والسلامة.',
      '',
      'ابدأ من هنا: سجّل، ثم افتح صفحة الإحالات للحصول على رابطك.',
      'المكافأة: {{referralPercent}}% من أول إيداع مؤهل للمستخدم الذي أحلت إليه (بحد أدنى ${{minDeposit}})، تُدفع مرة واحدة.',
      '',
      'التداول ينطوي على مخاطر والأرباح غير مضمونة.',
      '',
      '{{links}}'
    ].join('\n')
  }
};

const TEMPLATES = { en: EN, pt: PT, ar: AR };
const KINDS = Object.freeze(['welcome', 'startHere', 'channelIntro']);

function normalizeLocale(locale) {
  const value = String(locale === null || locale === undefined ? '' : locale).trim().toLowerCase();
  if (LOCALES.includes(value)) return value;
  const base = value.split(/[-_]/)[0];
  return LOCALES.includes(base) ? base : DEFAULT_LOCALE;
}

function labelsFor(locale) {
  return LABELS[normalizeLocale(locale)] || LABELS[DEFAULT_LOCALE];
}

/**
 * Build the localized "links" block from configured URLs.
 * Missing URLs are omitted entirely - no placeholder text, no invented handle.
 */
function buildLinksBlock(locale, ctx) {
  const labels = labelsFor(locale);
  const c = ctx || {};
  const lines = [];
  if (c.registerUrl) lines.push(labels.register + ': ' + c.registerUrl);
  if (c.supportUrl) lines.push(labels.support + ': ' + c.supportUrl);
  if (c.partnerSupportUrl) lines.push(labels.partnerSupport + ': ' + c.partnerSupportUrl);
  if (c.announcementUrl) lines.push(labels.announcements + ': ' + c.announcementUrl);
  return lines.join('\n');
}

/**
 * Single-purpose link lines used by the approved partner copy. A line is empty
 * when its URL is not configured, so nothing is invented and no blank URL is
 * rendered.
 */
function buildStepLines(locale, ctx) {
  const labels = labelsFor(locale);
  const c = ctx || {};
  // Each line is empty when its URL is not configured: nothing is invented and
  // no dangling label is rendered.
  return {
    learnLine: c.howItWorksUrl ? labels.learnHowItWorks + '\n' + c.howItWorksUrl : '',
    createLine: c.registerUrl ? labels.openRegister + ' ' + c.registerUrl : '',
    supportLine: c.supportUrl ? labels.supportLine + ' ' + c.supportUrl : '',
    partnerSupportLine: c.partnerSupportUrl
      ? labels.partnerSupportLine + ' ' + c.partnerSupportUrl
      : ''
  };
}

/**
 * The four approved partner buttons, in two rows of two. Each button carries its
 * `row` index so the same layout survives the database round trip (the publisher
 * stores a flat list and rebuilds the rows from this field).
 */
function partnerButtons(locale, ctx) {
  const b = labelsFor(locale).buttons;
  const c = ctx || {};
  const rows = [[], []];
  if (c.registerUrl) rows[0].push({ text: b.register, url: c.registerUrl, row: 0 });
  if (c.howItWorksUrl) rows[0].push({ text: b.howItWorks, url: c.howItWorksUrl, row: 0 });
  if (c.supportUrl) rows[1].push({ text: b.support, url: c.supportUrl, row: 1 });
  if (c.partnerSupportUrl) rows[1].push({ text: b.partnerSupport, url: c.partnerSupportUrl, row: 1 });
  return rows.reduce((all, row) => all.concat(row), []);
}

/** Inline keyboard built from configured URLs only. */
function buildButtons(locale, ctx, kind) {
  if (kind === 'welcome' || kind === 'startHere') return partnerButtons(locale, ctx);
  const labels = labelsFor(locale);
  const c = ctx || {};
  const buttons = [];
  if (c.registerUrl) buttons.push({ text: labels.register, url: c.registerUrl });
  if (c.announcementUrl) buttons.push({ text: labels.channel, url: c.announcementUrl });
  if (c.supportUrl) buttons.push({ text: labels.support, url: c.supportUrl });
  if (c.partnerSupportUrl) buttons.push({ text: labels.partnerSupport, url: c.partnerSupportUrl });
  return buttons;
}

/**
 * Group a flat button list into Telegram rows.
 * A button carrying a `row` index joins that row; a button without one keeps a
 * row of its own (the original one-per-row behaviour).
 */
function groupButtons(buttons) {
  const list = (buttons || []).filter((b) => b && b.url);
  const rows = [];
  for (const button of list) {
    const entry = { text: button.text, url: button.url };
    const row = Number(button.row);
    if (Number.isInteger(row) && row >= 0) {
      while (rows.length <= row) rows.push([]);
      rows[row].push(entry);
    } else {
      rows.push([entry]);
    }
  }
  return rows.filter((row) => row.length);
}

/** Wrap a flat list of URL buttons into Telegram's inline_keyboard shape. */
function toReplyMarkup(buttons) {
  const rows = groupButtons(buttons);
  if (!rows.length) return null;
  return { inline_keyboard: rows };
}

/**
 * The referral walkthrough shared by the welcome and the Start Here guide, so
 * the two can never drift apart. Every line is an approved, translatable step;
 * the personal link itself is NEVER constructed here - the member copies it from
 * their own authenticated account.
 */
function buildReferralSteps(locale) {
  const steps = labelsFor(locale).referralSteps || [];
  return steps.map((line) => '\u2022 ' + line).join('\n');
}

// A Telegram first name is short and self-contained. Anything carrying a link,
// a handle, a path or instruction-ish wording is not a name: it is rejected so
// an official partner message can never be used to relay a phishing line.
const NAME_REJECT_PATTERN = new RegExp(
  '[@:/\\\\]|\\b(?:https?|www|t\\.me|telegram|dm|pm|send|click|claim|contact|message|bonus|giveaway|airdrop|verify|password|passcode|seed|phrase|wallet|support|admin)\\b',
  'i'
);
const GREETING_NAME_WORDS_MAX = 5;

/**
 * Telegram `first_name` is user-controlled, and `sendMessage` sends PLAIN TEXT
 * (the transport sets no parse_mode), so HTML/Markdown escaping is deliberately
 * NOT applied - escaping would print `&amp;` literally. Instead the name is
 * reduced to a safe single-line plain-text token: control characters, zero-width
 * and bidi-override code points are removed, markup-significant `<`/`>` are
 * dropped, whitespace is collapsed and the value is capped (Telegram's own
 * first_name limit is 64). Anything unusable - empty, blank, a literal
 * "undefined"/"null" artifact, or a string that reads like an instruction, a
 * handle or a link (see NAME_REJECT_PATTERN) - returns null so the caller greets
 * generically rather than quoting it inside an official message.
 */
function sanitizeGreetingName(raw) {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === 'string' ? raw : String(raw);
  const cleaned = text
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GREETING_NAME_MAX)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim();
  if (!cleaned) return null;
  if (/^(undefined|null|none|n\/a)$/i.test(cleaned)) return null;
  if (NAME_REJECT_PATTERN.test(cleaned)) return null;
  if (cleaned.split(' ').length > GREETING_NAME_WORDS_MAX) return null;
  return cleaned;
}

/** Replace every {{placeholder}} using the supplied values. */
function interpolate(text, vars) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const value = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;
      return value === undefined || value === null ? match : String(value);
    });
}

/**
 * Render one of the approved templates.
 *
 * @param {string} kind    welcome | startHere | channelIntro | weekly
 * @param {string} locale  en | pt | ar
 * @param {object} ctx     { registerUrl, howItWorksUrl, supportUrl,
 *                           partnerSupportUrl, announcementUrl, minDeposit,
 *                           referralPercent, promoCredit, name, theme }
 */
function render(kind, locale, ctx) {
  const lang = normalizeLocale(locale);
  const c = ctx || {};
  const bundle = TEMPLATES[lang] || TEMPLATES[DEFAULT_LOCALE];
  const labels = labelsFor(lang);

  let text = null;
  let theme = null;

  if (kind === 'weekly') {
    theme = WEEKLY_THEMES.includes(c.theme) ? c.theme : 'mon';
    text = bundle.weekly[theme];
  } else if (KINDS.includes(kind)) {
    text = bundle[kind];
  } else {
    throw new Error('unknown marketing content kind: ' + kind);
  }

  const greetingName = sanitizeGreetingName(c.name);
  const greeting = greetingName
    ? interpolate(labels.greeting, { name: greetingName })
    : labels.greetingAnon;

  const rendered = interpolate(text, Object.assign({
    greeting,
    minDeposit: c.minDeposit,
    referralPercent: c.referralPercent,
    promoCredit: c.promoCredit,
    links: buildLinksBlock(lang, c),
    referralIntro: labels.referralIntro || '',
    referralSteps: buildReferralSteps(lang),
    referralReminder: labels.referralReminder || ''
  }, buildStepLines(lang, c))).replace(/\n{3,}/g, '\n\n').trim();

  const buttons = buildButtons(lang, c, kind);
  return {
    kind,
    locale: lang,
    theme,
    text: rendered,
    buttons,
    replyMarkup: toReplyMarkup(buttons)
  };
}

function weeklyKinds() {
  return WEEKLY_THEMES.slice();
}

module.exports = {
  LOCALES,
  DEFAULT_LOCALE,
  WEEKLY_THEMES,
  KINDS,
  LABELS,
  TEMPLATES,
  ARROW,
  normalizeLocale,
  buildLinksBlock,
  buildStepLines,
  buildReferralSteps,
  sanitizeGreetingName,
  GREETING_NAME_MAX,
  buildButtons,
  partnerButtons,
  groupButtons,
  toReplyMarkup,
  interpolate,
  render,
  weeklyKinds
};
