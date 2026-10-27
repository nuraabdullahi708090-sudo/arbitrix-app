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
const WEEKLY_THEMES = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const LABELS = {
  en: {
    greeting: 'Welcome to Arbitrix, {{name}}.',
    greetingAnon: 'Welcome to Arbitrix.',
    support: 'Customer support',
    partnerSupport: 'Partner payment support',
    announcements: 'Official announcements',
    register: 'Create your account',
    channel: 'Official channel'
  },
  pt: {
    greeting: 'Bem-vindo à Arbitrix, {{name}}.',
    greetingAnon: 'Bem-vindo à Arbitrix.',
    support: 'Suporte ao cliente',
    partnerSupport: 'Suporte de pagamentos a parceiros',
    announcements: 'Avisos oficiais',
    register: 'Criar sua conta',
    channel: 'Canal oficial'
  },
  ar: {
    greeting: 'مرحبًا بك في Arbitrix، {{name}}.',
    greetingAnon: 'مرحبًا بك في Arbitrix.',
    support: 'دعم العملاء',
    partnerSupport: 'دعم مدفوعات الشركاء',
    announcements: 'الإعلانات الرسمية',
    register: 'أنشئ حسابك',
    channel: 'القناة الرسمية'
  }
};

const EN = {
  welcome: [
    '{{greeting}}',
    '',
    'Arbitrix is automated multi-asset arbitrage software. It compares prices for the same instrument on different venues and records the result of each execution in your account.',
    '',
    'Your next steps:',
    '1. See how it works - Demo Mode uses virtual funds, so you can explore before funding anything.',
    '2. Create your account - it takes about a minute.',
    '3. Open the Referral page after registering to find your personal link and code.',
    '4. Referral reward: {{referralPercent}}% of your referred user\'s first qualifying deposit (minimum ${{minDeposit}}). This is a one-time reward, not a recurring commission.',
    '5. Need help? The support contacts are listed below.',
    '',
    '{{links}}',
    '',
    'Trading involves risk and profits are not guaranteed. Demo results do not predict live results.'
  ].join('\n'),

  startHere: [
    'START HERE',
    '',
    '1. Understand the product',
    'Arbitrix is automated arbitrage software. It compares prices for the same instrument across venues and records the result of each execution in your account.',
    '',
    '2. Know the two modes',
    'Demo Mode uses virtual funds and nothing is at risk. Live Mode uses your own deposited funds. The minimum deposit for Live is ${{minDeposit}}.',
    '',
    '3. Register',
    'Create your account, then sign in. Registration and the dashboard are on the official site only.',
    '',
    '4. Find your referral link',
    'Open Referral in the sidebar. Your personal code and link are shown there.',
    '',
    '5. Understand the reward',
    'You earn {{referralPercent}}% of your referred user\'s first qualifying deposit (minimum ${{minDeposit}}). The reward is paid once. There is no recurring or lifetime commission.',
    '',
    '6. Promote responsibly',
    'Describe what the platform does. Do not promise profits and never describe trading as risk-free.',
    '',
    '7. Get help',
    'Use the support contacts below. Account questions go to customer support; payout questions go to partner payment support.',
    '',
    '{{links}}',
    '',
    'Trading involves risk and profits are not guaranteed.'
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
    'A Arbitrix é um software automatizado de arbitragem multi-ativo. Ele compara preços do mesmo instrumento em corretoras diferentes e registra o resultado de cada execução na sua conta.',
    '',
    'Seus próximos passos:',
    '1. Veja como funciona - o Modo Demo usa fundos virtuais, então você pode explorar antes de depositar.',
    '2. Crie sua conta - leva cerca de um minuto.',
    '3. Abra a página de Indicações depois de se registrar para encontrar seu link e código.',
    '4. Recompensa de indicação: {{referralPercent}}% do primeiro depósito qualificado do seu indicado (mínimo ${{minDeposit}}). É um pagamento único, não uma comissão recorrente.',
    '5. Precisa de ajuda? Os contatos de suporte estão abaixo.',
    '',
    '{{links}}',
    '',
    'Negociar envolve risco e os lucros não são garantidos. Resultados no Modo Demo não preveem resultados reais.'
  ].join('\n'),

  startHere: [
    'COMECE AQUI',
    '',
    '1. Entenda o produto',
    'A Arbitrix é um software automatizado de arbitragem. Ele compara preços do mesmo instrumento em corretoras diferentes e registra o resultado de cada execução na sua conta.',
    '',
    '2. Conheça os dois modos',
    'O Modo Demo usa fundos virtuais e nada está em risco. O Modo Live usa os seus próprios fundos depositados. O depósito mínimo para o Live é ${{minDeposit}}.',
    '',
    '3. Registre-se',
    'Crie sua conta e entre. O cadastro e o painel ficam apenas no site oficial.',
    '',
    '4. Encontre seu link de indicação',
    'Abra Indicações no menu lateral. Seu código e link pessoais aparecem ali.',
    '',
    '5. Entenda a recompensa',
    'Você recebe {{referralPercent}}% do primeiro depósito qualificado do seu indicado (mínimo ${{minDeposit}}). A recompensa é paga uma única vez. Não existe comissão recorrente ou vitalícia.',
    '',
    '6. Divulgue com responsabilidade',
    'Descreva o que a plataforma faz. Não prometa lucros e nunca diga que negociar não tem risco.',
    '',
    '7. Obtenha ajuda',
    'Use os contatos abaixo. Dúvidas de conta vão para o suporte ao cliente; dúvidas de pagamento vão para o suporte de pagamentos a parceiros.',
    '',
    '{{links}}',
    '',
    'Negociar envolve risco e os lucros não são garantidos.'
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
    'Arbitrix منصة مراجحة آلية متعددة الأصول. تتابع فروق الأسعار للأداة نفسها في منصات مختلفة، وتسجل نتيجة كل تنفيذ في حسابك.',
    '',
    'خطواتك التالية:',
    '1. تعرّف على المنصة - يستخدم الوضع التجريبي أموالًا افتراضية، لذا يمكنك الاستكشاف قبل الإيداع.',
    '2. أنشئ حسابك - يستغرق حوالي دقيقة.',
    '3. افتح صفحة الإحالات بعد التسجيل للعثور على رابطك ورمزك.',
    '4. مكافأة الإحالة: {{referralPercent}}% من أول إيداع مؤهل للمستخدم الذي أحلت إليه (بحد أدنى ${{minDeposit}}). وهي دفعة لمرة واحدة، وليست عمولة متكررة.',
    '5. تحتاج مساعدة؟ جهات الدعم مدرجة أدناه.',
    '',
    '{{links}}',
    '',
    'التداول ينطوي على مخاطر والأرباح غير مضمونة. نتائج الوضع التجريبي لا تتنبأ بالنتائج الفعلية.'
  ].join('\n'),

  startHere: [
    'ابدأ من هنا',
    '',
    '1. افهم المنتج',
    'Arbitrix برنامج مراجحة آلي. يقارن أسعار الأداة نفسها في منصات مختلفة، ويسجل نتيجة كل تنفيذ في حسابك.',
    '',
    '2. اعرف الوضعين',
    'يستخدم الوضع التجريبي أموالًا افتراضية، ولا شيء معرض للخطر. ويستخدم الوضع الحقيقي أموالك المودعة. الحد الأدنى للإيداع في الوضع الحقيقي هو ${{minDeposit}}.',
    '',
    '3. سجّل',
    'أنشئ حسابك ثم سجّل الدخول. التسجيل ولوحة التحكم متاحان على الموقع الرسمي فقط.',
    '',
    '4. اعثر على رابط الإحالة',
    'افتح صفحة الإحالات في القائمة الجانبية. يظهر رمزك ورابطك الشخصي هناك.',
    '',
    '5. افهم المكافأة',
    'تحصل على {{referralPercent}}% من أول إيداع مؤهل للمستخدم الذي أحلت إليه (بحد أدنى ${{minDeposit}}). تُدفع المكافأة مرة واحدة. لا توجد عمولة متكررة أو مدى الحياة.',
    '',
    '6. رَوّج بمسؤولية',
    'اشرح ما تفعله المنصة. لا تعد بأرباح، ولا تصف التداول أبدًا بأنه بلا مخاطر.',
    '',
    '7. احصل على المساعدة',
    'استخدم جهات الدعم أدناه. أسئلة الحساب إلى دعم العملاء، وأسئلة الدفع إلى دعم مدفوعات الشركاء.',
    '',
    '{{links}}',
    '',
    'التداول ينطوي على مخاطر والأرباح غير مضمونة.'
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

/** Inline keyboard built from configured URLs only. */
function buildButtons(locale, ctx) {
  const labels = labelsFor(locale);
  const c = ctx || {};
  const buttons = [];
  if (c.registerUrl) buttons.push({ text: labels.register, url: c.registerUrl });
  if (c.announcementUrl) buttons.push({ text: labels.channel, url: c.announcementUrl });
  if (c.supportUrl) buttons.push({ text: labels.support, url: c.supportUrl });
  if (c.partnerSupportUrl) buttons.push({ text: labels.partnerSupport, url: c.partnerSupportUrl });
  return buttons;
}

/** Wrap a flat list of URL buttons into Telegram's inline_keyboard shape. */
function toReplyMarkup(buttons) {
  const list = (buttons || []).filter((b) => b && b.url);
  if (!list.length) return null;
  // One button per row: long localized labels stay readable on a phone.
  return { inline_keyboard: list.map((b) => [{ text: b.text, url: b.url }]) };
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
 * @param {object} ctx     { registerUrl, supportUrl, partnerSupportUrl,
 *                           announcementUrl, minDeposit, referralPercent,
 *                           promoCredit, name, theme }
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

  const greeting = c.name
    ? interpolate(labels.greeting, { name: String(c.name) })
    : labels.greetingAnon;

  const rendered = interpolate(text, {
    greeting,
    minDeposit: c.minDeposit,
    referralPercent: c.referralPercent,
    promoCredit: c.promoCredit,
    links: buildLinksBlock(lang, c)
  }).replace(/\n{3,}/g, '\n\n').trim();

  const buttons = buildButtons(lang, c);
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
  buildButtons,
  toReplyMarkup,
  interpolate,
  render,
  weeklyKinds
};
