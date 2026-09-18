 const express = require('express');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse/lib/pdf-parse.js'); // caminho interno evita bug do entry point

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_URL = process.env.AI_API_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const AI_MODEL = process.env.AI_MODEL || "gemini-2.5-flash";
const AI_FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || ""; // novo: modelo reserva
const ALLOWED_IDS = (process.env.BOT_ALLOWED_IDS || "").split(',').map(s => s.trim()).filter(Boolean); // novo: allowlist
const WEBHOOK_BASE = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '';

const DATA_FILE = path.join(__dirname, 'database.json');
const MAX_HISTORICO = 20;
const MAX_PDF_CHARS = 10000;
const MAX_URL_CHARS = 6000;
const MAX_RESPOSTA_CHARS = 4000; // limite seguro do Telegram (4096)
const MAX_RETRIES = 3;
const COOLDOWN_MS = 1500; // anti-flood entre mensagens do mesmo chat

process.on('uncaughtException', (err) => console.error('ERRO NAO TRATADO:', err));
process.on('unhandledRejection', (reason) => console.error('REJEICAO NAO TRATADA:', reason));

function carregarBanco() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const dados = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!dados.perfisUsuarios) dados.perfisUsuarios = {};
      if (!dados.historicoConversas) dados.historicoConversas = {};
      return dados;
    } catch (e) {
      console.error('Erro ao carregar banco:', e);
    }
  }
  return { perfisUsuarios: {}, historicoConversas: {} };
}

let writeQueue = Promise.resolve();
function salvarBanco(banco) {
  writeQueue = writeQueue.then(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(banco, null, 2));
    } catch (e) {
      console.error('Erro ao salvar banco:', e);
    }
  });
}

const banco = carregarBanco();
const ultimaAtividade = {};        // anti-flood por chat
const updatesVistos = new Set();   // dedupe de webhooks duplicados

function dividirTexto(texto, max) {
  const partes = [];
  let resto = String(texto || '');
  if (!resto) return ['Desculpe, nao consegui gerar uma resposta agora. Tente novamente.'];
  while (resto.length > max) {
    let corte = resto.lastIndexOf('\n', max);
    if (corte < max * 0.5) corte = resto.lastIndexOf(' ', max);
    if (corte < max * 0.5) corte = max;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto) partes.push(resto);
  return partes;
}

async function enviarMensagemTelegram(chatId, text) {
  const partes = dividirTexto(text, MAX_RESPOSTA_CHARS);
  for (const parte of partes) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: parte })
      });
      const data = await res.json();
      if (!data.ok) console.error('Telegram retornou erro:', data);
    } catch (e) {
      console.error('Erro ao enviar mensagem:', e);
    }
  }
}

async function enviarAcaoDigitando(chatId) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch (e) { /* silencioso */ }
}

async function configurarWebhook() {
  if (!TELEGRAM_TOKEN) return console.error('TELEGRAM_TOKEN ausente');
  const webhookUrl = WEBHOOK_BASE
    ? `${WEBHOOK_BASE.replace(/\/$/, '')}/webhook`
    : 'https://telegram-gemini-bot-pmyx.onrender.com/webhook';
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] })
    });
    const data = await res.json();
    console.log('Webhook configurado:', webhookUrl, JSON.stringify(data));
    console.log(`IA configurada: ${AI_API_URL} | Modelo: ${AI_MODEL} | Fallback: ${AI_FALLBACK_MODEL || 'nenhum'}`);
  } catch (e) {
    console.error('Erro ao configurar webhook:', e);
  }
}

async function baixarArquivoTelegram(fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error('Nao foi possivel obter o arquivo');
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${info.result.file_path}`);
  if (!fileRes.ok) throw new Error('Falha ao baixar arquivo');
  const buffer = await fileRes.arrayBuffer();
  return Buffer.from(buffer);
}

async function extrairTextoPDF(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text;
  } catch (e) {
    console.error('Erro ao extrair PDF:', e);
    return null;
  }
}

async function extrairTextoURL(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; bob-ia-bot/1.0)',
      'Accept': 'text/html'
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let html = (await res.text()).substring(0, 200000);
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return html.substring(0, MAX_URL_CHARS);
}

async function transcreverAudio(buffer, mimeType) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${AI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: 'Transcreva este audio/video. Responda apenas com a transcricao do conteudo.' },
            { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } }
          ]
        }]
      })
    });
    const data = await res.json();
    const texto = (data?.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '')
      .join(' ')
      .trim();
    return texto || null;
  } catch (e) {
    console.error('Erro ao transcrever audio:', e);
    return null;
  }
}

async function chamarIA(mensagensParaAPI) {
  let lastError = null;
  for (let tentativa = 1; tentativa <= MAX_RETRIES; tentativa++) {
    try {
      const iaRes = await fetch(AI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({ model: AI_MODEL, messages: mensagensParaAPI })
      });
      const data = await iaRes.json();

      if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content;
      }
      if (data.error) {
        const msg = typeof data.error === 'string'
          ? data.error
          : (data.error.message || JSON.stringify(data.error));
        if (iaRes.status === 401) return `Erro da IA: ${msg}`; // credencial invalida, nao adianta fallback
        lastError = new Error(msg);
      } else {
        lastError = new Error('Resposta inesperada da IA');
      }
    } catch (e) {
      lastError = e;
    }
    if (tentativa < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000 * tentativa));
  }

  // Novo: tenta o modelo fallback apos as retentativas esgotarem
  if (AI_FALLBACK_MODEL && AI_FALLBACK_MODEL !== AI_MODEL) {
    console.log('Tentando modelo fallback:', AI_FALLBACK_MODEL);
    try {
      const iaRes = await fetch(AI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_API_KEY}`
        },
        body: JSON.stringify({ model: AI_FALLBACK_MODEL, messages: mensagensParaAPI })
      });
      const data = await iaRes.json();
      if (data.choices && data.choices[0] && data.choices[0].message) {
        return data.choices[0].message.content;
      }
      if (data.error) {
        const msg = typeof data.error === 'string'
          ? data.error
          : (data.error.message || JSON.stringify(data.error));
        return `Erro da IA (fallback): ${msg}`;
      }
    } catch (e) {
      console.error('Fallback tambem falhou:', e);
    }
  }

  return `Erro: ${lastError ? lastError.message : 'falha ao chamar a IA'}`;
}

app.post('/webhook', (req, res) => {
  res.sendStatus(200); // evita reenvio do Telegram em chamadas lentas

  const updateId = req.body.update_id;
  if (updateId != null) {
    if (updatesVistos.has(updateId)) return;
    updatesVistos.add(updateId);
    if (updatesVistos.size > 2000) updatesVistos.clear();
  }

  const message = req.body.message;
  if (!message) return;

  processarMensagem(message).catch((err) => {
    console.error('Erro no processamento:', err);
    enviarMensagemTelegram(String(message.chat.id), 'Ocorreu um erro interno. Tente novamente.');
  });
});

async function processarMensagem(message) {
  const chatId = message.chat.id.toString();
  const userInfo = message.from || {};

  if (!banco.perfisUsuarios[chatId]) {
    banco.perfisUsuarios[chatId] = {
      first_name: userInfo.first_name || 'usuario',
      username: userInfo.username || '',
      criadoEm: new Date().toISOString(),
      mensagens: 0
    };
  }
  const perfil = banco.perfisUsuarios[chatId];
  perfil.mensagens = (perfil.mensagens || 0) + 1;
  perfil.ultimoUso = new Date().toISOString();

  if (!banco.historicoConversas[chatId]) banco.historicoConversas[chatId] = [];
  const historico = banco.historicoConversas[chatId];

  // Novo: allowlist. Se definida, so chats autorizados usam o bot.
  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(chatId)) {
    if (!perfil.bloqueado) {
      perfil.bloqueado = true;
      salvarBanco(banco);
      await enviarMensagemTelegram(chatId, 'Acesso nao autorizado.');
    }
    return;
  }

  const textoComando = (message.text || '').trim();

  // Novo: comandos diretos, nao gastam token de IA
  if (textoComando === '/start' || textoComando === '/help') {
    const ajuda = [
      '/start ou /help: esta ajuda',
      '/limpar: apaga o historico da conversa',
      '/modelo: mostra o modelo de IA em uso',
      '/stats: mostra quantas mensagens voce enviou',
      '',
      'Tambem posso:',
      '- Analisar imagens, PDFs e arquivos',
      '- Transcrever audios e videos',
      '- Ler e resumir URLs',
      '- Manter contexto das conversas'
    ].join('\n');
    return enviarMensagemTelegram(chatId, ajuda);
  }
  if (textoComando === '/limpar') {
    banco.historicoConversas[chatId] = [];
    salvarBanco(banco);
    return enviarMensagemTelegram(chatId, 'Historico apagado. Conversa reiniciada.');
  }
  if (textoComando === '/modelo') {
    const extra = AI_FALLBACK_MODEL ? ` | fallback: ${AI_FALLBACK_MODEL}` : '';
    return enviarMensagemTelegram(chatId, `Modelo ativo: ${AI_MODEL}${extra}`);
  }
  if (textoComando === '/stats') {
    return enviarMensagemTelegram(chatId, `Voce enviou ${perfil.mensagens} mensagens desde o inicio.`);
  }

  // Anti-flood: ignora mensagens muito seguidas (comandos passam)
  const agora = Date.now();
  if (agora - (ultimaAtividade[chatId] || 0) < COOLDOWN_MS) return;
  ultimaAtividade[chatId] = agora;

  await enviarAcaoDigitando(chatId); // mostra "digitando..." no Telegram

  let textoUsuario = '';
  let textoHistorico = '';
  let imagemBase64 = null;
  let mimeType = 'image/jpeg';

  if (message.photo) {
    const photo = message.photo[message.photo.length - 1];
    const buffer = await baixarArquivoTelegram(photo.file_id);
    imagemBase64 = buffer.toString('base64');
    textoUsuario = message.caption || 'Analise esta imagem em detalhes.';
    textoHistorico = textoUsuario;
  } else if (message.voice || message.video_note) {
    // Novo: transcricao de audios e videos (notas de voz)
    const arquivo = message.voice || message.video_note;
    const buffer = await baixarArquivoTelegram(arquivo.file_id);
    const mime = message.voice ? 'audio/ogg' : 'video/mp4';
    const transcricao = await transcreverAudio(buffer, mime);
    textoUsuario = transcricao
      ? `Transcricao de audio/video enviado: ${transcricao}`
      : 'Recebi um audio/video mas nao consegui transcrever. Pode mandar em texto?';
    textoHistorico = transcricao || '';
  } else if (message.document) {
    const buffer = await baixarArquivoTelegram(message.document.file_id);
    const mime = message.document.mime_type || '';
    if (mime === 'application/pdf') {
      const textoPDF = await extrairTextoPDF(buffer);
      if (textoPDF) {
        textoUsuario = `PDF: ${message.document.file_name}\n\n${textoPDF.substring(0, MAX_PDF_CHARS)}`;
        textoHistorico = `[PDF: ${message.document.file_name}]`; // historico enxuto
      } else {
        textoUsuario = `Recebi o PDF "${message.document.file_name}" mas nao consegui extrair o texto.`;
        textoHistorico = textoUsuario;
      }
    } else if (mime.startsWith('image/')) {
      imagemBase64 = buffer.toString('base64');
      mimeType = mime;
      textoUsuario = message.caption || 'Analise esta imagem.';
      textoHistorico = textoUsuario;
    } else {
      textoUsuario = `Recebi o arquivo "${message.document.file_name}" mas nao consigo processar este tipo.`;
      textoHistorico = textoUsuario;
    }
  } else if (message.text) {
    textoUsuario = message.text;
    textoHistorico = textoUsuario;
  } else {
    return;
  }

  // Novo: leitura automatica de URLs
  if (/^https?:\/\/\S+$/i.test(textoUsuario.trim())) {
    textoHistorico = `[URL: ${textoUsuario.trim()}]`;
    try {
      const conteudo = await extrairTextoURL(textoUsuario.trim());
      textoUsuario = `Resuma esta URL: ${textoUsuario.trim()}\n\nConteudo da pagina:\n${conteudo}`;
    } catch (e) {
      textoUsuario = `URL: ${textoUsuario.trim()}\n(nao consegui acessar o conteudo da pagina)`;
    }
  }

  let conteudoMensagem;
  if (imagemBase64) {
    conteudoMensagem = [
      { type: 'text', text: textoUsuario },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imagemBase64}` } }
    ];
  } else {
    conteudoMensagem = textoUsuario;
  }

  const mensagensParaAPI = [
    {
      role: 'system',
      content: `Voce e o Bob IA, um assistente inteligente e amigavel conversando com ${perfil.first_name}. Responde sempre em portugues, de forma clara e util. Se o texto vier com prefixo "PDF:", resuma ou responda sobre o documento. Se vier com "Transcricao de audio", responda com base nela. Se vier com "Resuma esta URL", resuma o conteudo da pagina.`
    },
    ...historico,
    { role: 'user', content: conteudoMensagem }
  ];

  if (textoHistorico) {
    historico.push({ role: 'user', content: textoHistorico });
    if (historico.length > MAX_HISTORICO) historico.shift();
  }

  const resposta = await chamarIA(mensagensParaAPI);

  historico.push({ role: 'assistant', content: resposta });
  if (historico.length > MAX_HISTORICO) historico.shift();
  salvarBanco(banco);

  await enviarMensagemTelegram(chatId, resposta);
}

app.get('/webhook', (req, res) => res.send('Bob IA ativo.'));
app.get('/', (req, res) => res.send('Bob IA rodando!'));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  configurarWebhook();
});
