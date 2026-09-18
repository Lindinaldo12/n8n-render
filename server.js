require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse/lib/pdf-parse.js');
const cron = require('node-cron');
const BobBrain = require('./brain.js');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_URL = process.env.AI_API_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const AI_MODEL = process.env.AI_MODEL || "gemini-2.5-flash";
const AI_FALLBACK_URL = process.env.AI_FALLBACK_URL || AI_API_URL;
const AI_FALLBACK_KEY = process.env.AI_FALLBACK_KEY || AI_API_KEY;
const AI_FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || "";
const ALLOWED_IDS = (process.env.BOT_ALLOWED_IDS || "").split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(s => s.trim()).filter(Boolean);
const WEBHOOK_BASE = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '';
const BOT_NAME = process.env.BOT_NAME || 'Bob IA';
const BOT_PERSONA = process.env.BOT_PERSONA || 'um assistente inteligente e amigavel';
const BOB_MASTER_ID = process.env.BOB_MASTER_ID || '';

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '';
const CRON_MESSAGE = process.env.CRON_MESSAGE || '';
const CRON_TARGET = process.env.CRON_TARGET || '';

const MAX_PDF_CHARS = 10000;
const MAX_URL_CHARS = 6000;
const MAX_RESPOSTA_CHARS = 4000;
const MAX_RETRIES = 3;
const COOLDOWN_MS = 1500;
const MAX_BUSCA_RESULTADOS = 5;

process.on('uncaughtException', (err) => console.error('ERRO NAO TRATADO:', err));
process.on('unhandledRejection', (reason) => console.error('REJEICAO NAO TRATADA:', reason));

const ultimaAtividade = {};
const updatesVistos = new Set();

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
    console.log(`IA: ${AI_API_URL} | Modelo: ${AI_MODEL} | Fallback: ${AI_FALLBACK_MODEL || 'nenhum'}`);
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

async function buscarNaWeb(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; bob-ia-bot/1.0)',
      'Accept': 'text/html'
    },
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let html = (await res.text()).substring(0, 600000);

  const links = [];
  const reA = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = reA.exec(html)) !== null && links.length < MAX_BUSCA_RESULTADOS) {
    let href = m[1].trim();
    if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
      try {
        href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]);
      } catch (e) { /* mantiene href */ }
    }
    const titulo = m[2].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
    links.push({ href, titulo });
  }

  const snippets = [];
  const reS = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let ms;
  while ((ms = reS.exec(html)) !== null && snippets.length < MAX_BUSCA_RESULTADOS) {
    snippets.push(ms[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim());
  }

  if (links.length === 0) return 'Nenhum resultado encontrado.';
  return links.map((l, i) => {
    const snip = snippets[i] ? `\n${snippets[i].substring(0, 200)}` : '';
    return `${i + 1}. ${l.titulo}\n${l.href}${snip}`;
  }).join('\n\n');
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
        if (iaRes.status === 401) return `Erro da IA: ${msg}`;
        lastError = new Error(msg);
      } else {
        lastError = new Error('Resposta inesperada da IA');
      }
    } catch (e) {
      lastError = e;
    }
    if (tentativa < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000 * tentativa));
  }

  if (AI_FALLBACK_MODEL && AI_FALLBACK_MODEL !== AI_MODEL) {
    console.log('Tentando modelo fallback:', AI_FALLBACK_MODEL);
    try {
      const iaRes = await fetch(AI_FALLBACK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AI_FALLBACK_KEY}`
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

// Inicializa o cérebro e conecta ao Gemini
const bob = new BobBrain();
bob.setAIProvider(chamarIA);
bob.init().then(() => {
  if (BOB_MASTER_ID) bob.setMaster(BOB_MASTER_ID);
  console.log('Bob Brain conectado ao servidor.');
});

function iniciarCron() {
  if (!CRON_SCHEDULE || !CRON_MESSAGE) {
    console.log('Cron desativado. Defina CRON_SCHEDULE e CRON_MESSAGE para ativar.');
    return;
  }
  if (!cron.validate(CRON_SCHEDULE)) {
    console.error('CRON_SCHEDULE invalido:', CRON_SCHEDULE);
    return;
  }
  cron.schedule(CRON_SCHEDULE, async () => {
    console.log('Executando tarefa agendada:', new Date().toISOString());
    if (CRON_TARGET) {
      await enviarMensagemTelegram(CRON_TARGET, CRON_MESSAGE);
    } else {
      const users = bob.memory ? Object.keys(bob.memory.data.users || {}) : [];
      for (const id of users) {
        await enviarMensagemTelegram(id, CRON_MESSAGE);
      }
    }
  }, { timezone: 'America/Sao_Paulo' });
  console.log(`Cron ativo: ${CRON_SCHEDULE} (America/Sao_Paulo) | Alvo: ${CRON_TARGET || 'todos os usuarios'}`);
}

app.post('/webhook', (req, res) => {
  res.sendStatus(200);

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
  const isMaster = bob.isMaster(chatId);

  // Acesso: Master sempre passa; demais checam allowlist
  if (!isMaster && ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(chatId)) {
    return enviarMensagemTelegram(chatId, 'Acesso nao autorizado.');
  }

  const textoComando = (message.text || '').trim();

  if (textoComando === '/start' || textoComando === '/help') {
    const ajuda = [
      '/start ou /help: esta ajuda',
      '/limpar: apaga o historico do cérebro',
      '/modelo: mostra o modelo de IA em uso',
      '/stats: quantas mensagens voce enviou',
      '/id: mostra o chat id',
      '/busca <termo>: pesquisa na web',
      '/cron: status da tarefa agendada (admin)',
      '/broadcast <msg>: envia para todos (admin)',
      '/block <id> e /unblock <id>: gerencia usuarios (Master)',
      '',
      'Tambem posso:',
      '- Analisar imagens, PDFs e arquivos',
      '- Transcrever audios e videos',
      '- Ler e resumir URLs',
      '- Buscar informacoes atuais na web',
      '- Manter memoria persistente por usuario'
    ].join('\n');
    return enviarMensagemTelegram(chatId, ajuda);
  }
  if (textoComando === '/limpar') {
    await bob.memory.deleteUserMemory(chatId);
    return enviarMensagemTelegram(chatId, 'Memoria apagada. Conversa reiniciada.');
  }
  if (textoComando === '/modelo') {
    const extra = AI_FALLBACK_MODEL ? ` | fallback: ${AI_FALLBACK_MODEL}` : '';
    return enviarMensagemTelegram(chatId, `Modelo ativo: ${AI_MODEL}${extra}`);
  }
  if (textoComando === '/stats') {
    const ctx = bob.memory.getContext(chatId);
    const n = ctx.recentConversation ? ctx.recentConversation.length : 0;
    return enviarMensagemTelegram(chatId, `Conversa atual com ${n} mensagens no contexto.`);
  }
  if (textoComando === '/id') {
    return enviarMensagemTelegram(chatId, `Seu chat id: ${chatId}`);
  }
  if (/^\/cron\b/i.test(textoComando)) {
    if (!ADMIN_IDS.includes(chatId) && !isMaster) {
      return enviarMensagemTelegram(chatId, 'Sem permissao para este comando.');
    }
    if (/^\/cron\s+test$/i.test(textoComando)) {
      if (!CRON_MESSAGE) return enviarMensagemTelegram(chatId, 'CRON_MESSAGE nao definido.');
      await enviarMensagemTelegram(chatId, CRON_MESSAGE);
      return enviarMensagemTelegram(chatId, 'Mensagem do cron enviada (teste).');
    }
    const status = CRON_SCHEDULE && CRON_MESSAGE
      ? `Cron ativo: ${CRON_SCHEDULE}\nAlvo: ${CRON_TARGET || 'todos os usuarios'}`
      : 'Cron desativado. Defina CRON_SCHEDULE e CRON_MESSAGE.';
    return enviarMensagemTelegram(chatId, status);
  }
  if (/^\/busca\b/i.test(textoComando)) {
    const termo = textoComando.replace(/^\/busca\b\s*/i, '').trim();
    if (!termo) return enviarMensagemTelegram(chatId, 'Uso: /busca <termo>');
    await enviarAcaoDigitando(chatId);
    try {
      const resultados = await buscarNaWeb(termo);
      return enviarMensagemTelegram(chatId, `Resultados para "${termo}":\n\n${resultados}`);
    } catch (e) {
      return enviarMensagemTelegram(chatId, 'Nao consegui buscar agora. Tente novamente.');
    }
  }
  if (/^\/broadcast\b/i.test(textoComando)) {
    if (!ADMIN_IDS.includes(chatId) && !isMaster) {
      return enviarMensagemTelegram(chatId, 'Sem permissao para este comando.');
    }
    const msg = textoComando.replace(/^\/broadcast\b\s*/i, '').trim();
    if (!msg) return enviarMensagemTelegram(chatId, 'Uso: /broadcast <mensagem>');
    const users = bob.memory ? Object.keys(bob.memory.data.users || {}) : [];
    let enviadas = 0;
    for (const id of users) {
      if (id === chatId) continue;
      await enviarMensagemTelegram(id, msg);
      enviadas++;
    }
    return enviarMensagemTelegram(chatId, `Broadcast enviado para ${enviadas} chats.`);
  }
  if (/^\/block\b/i.test(textoComando)) {
    if (!isMaster) return enviarMensagemTelegram(chatId, 'Sem permissao para este comando.');
    const alvo = textoComando.replace(/^\/block\b\s*/i, '').trim();
    if (!alvo) return enviarMensagemTelegram(chatId, 'Uso: /block <chat id>');
    await bob.admin(chatId, 'block', alvo);
    return enviarMensagemTelegram(chatId, `Usuario ${alvo} bloqueado.`);
  }
  if (/^\/unblock\b/i.test(textoComando)) {
    if (!isMaster) return enviarMensagemTelegram(chatId, 'Sem permissao para este comando.');
    const alvo = textoComando.replace(/^\/unblock\b\s*/i, '').trim();
    if (!alvo) return enviarMensagemTelegram(chatId, 'Uso: /unblock <chat id>');
    await bob.admin(chatId, 'unblock', alvo);
    return enviarMensagemTelegram(chatId, `Usuario ${alvo} desbloqueado.`);
  }

  const agora = Date.now();
  if (agora - (ultimaAtividade[chatId] || 0) < COOLDOWN_MS) return;
  ultimaAtividade[chatId] = agora;

  await enviarAcaoDigitando(chatId);

  let textoUsuario = '';
  let imagemBase64 = null;
  let mimeType = 'image/jpeg';
  let extraContext = '';

  if (message.photo) {
    const photo = message.photo[message.photo.length - 1];
    const buffer = await baixarArquivoTelegram(photo.file_id);
    imagemBase64 = buffer.toString('base64');
    textoUsuario = message.caption || 'Analise esta imagem em detalhes.';
  } else if (message.voice || message.video_note) {
    const arquivo = message.voice || message.video_note;
    const buffer = await baixarArquivoTelegram(arquivo.file_id);
    const mime = message.voice ? 'audio/ogg' : 'video/mp4';
    const transcricao = await transcreverAudio(buffer, mime);
    textoUsuario = transcricao
      ? `Transcricao de audio/video enviado: ${transcricao}`
      : 'Recebi um audio/video mas nao consegui transcrever. Pode mandar em texto?';
  } else if (message.document) {
    const buffer = await baixarArquivoTelegram(message.document.file_id);
    const mime = message.document.mime_type || '';
    if (mime === 'application/pdf') {
      const textoPDF = await extrairTextoPDF(buffer);
      if (textoPDF) {
        textoUsuario = `PDF: ${message.document.file_name}\n\n${textoPDF.substring(0, MAX_PDF_CHARS)}`;
      } else {
        textoUsuario = `Recebi o PDF "${message.document.file_name}" mas nao consegui extrair o texto.`;
      }
    } else if (mime.startsWith('image/')) {
      imagemBase64 = buffer.toString('base64');
      mimeType = mime;
      textoUsuario = message.caption || 'Analise esta imagem.';
    } else {
      textoUsuario = `Recebi o arquivo "${message.document.file_name}" mas nao consigo processar este tipo.`;
    }
  } else if (message.text) {
    textoUsuario = message.text;
  } else {
    return;
  }

  const buscaAuto = /(buscar|pesquisar|not[íi]cias? (de|sobre|do|da)|cota[çc][ãa]o|pre[çc]o atual|quanto custa (hoje|agora)|lan[çc]amento (mais recente|do)|o que houve|o que mudou)/i;
  if (message.text && !message.text.trim().startsWith('/') && textoUsuario.length > 15 && buscaAuto.test(textoUsuario)) {
    try {
      const resultados = await buscarNaWeb(textoUsuario);
      if (resultados && !resultados.startsWith('Nenhum resultado')) {
        extraContext = `Resultados da busca na web:\n${resultados}\nResponda com base neles, citando fontes.`;
      }
    } catch (e) {
      console.error('Erro na busca web automatica:', e);
    }
  }

  if (/^https?:\/\/\S+$/i.test(textoUsuario.trim())) {
    try {
      const conteudo = await extrairTextoURL(textoUsuario.trim());
      extraContext = `Conteudo da URL ${textoUsuario.trim()}:\n${conteudo}\nResuma esta pagina.`;
    } catch (e) {
      extraContext = `URL: ${textoUsuario.trim()}\n(nao consegui acessar o conteudo da pagina)`;
    }
  }

  // Monta a mensagem com imagem, se houver
  let promptFinal = textoUsuario;
  if (imagemBase64) {
    promptFinal = `[IMAGEM enviada] ${textoUsuario}`;
  }

  const resultado = await bob.process({ userId: chatId, message: promptFinal, extraContext });
  const resposta = resultado.response || 'Desculpe, nao consegui gerar uma resposta agora.';

  await enviarMensagemTelegram(chatId, resposta);
}

app.get('/webhook', (req, res) => res.send('Bob IA ativo.'));
app.get('/health', (req, res) => res.send('ok'));
app.get('/', (req, res) => res.send('Bob IA rodando!'));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  configurarWebhook();
  iniciarCron();
});
