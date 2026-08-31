const express = require('express');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_URL = process.env.AI_API_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const AI_MODEL = process.env.AI_MODEL || "gemini-2.5-flash";

const DATA_FILE = path.join(__dirname, 'database.json');

process.on('uncaughtException', (err) => {
  console.error('ERRO NÃO TRATADO:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('REJEIÇÃO NÃO TRATADA:', reason);
});

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

function salvarBanco(banco) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(banco, null, 2));
  } catch (e) {
    console.error('Erro ao salvar banco:', e);
  }
}

const banco = carregarBanco();

async function enviarMensagemTelegram(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (e) {
    console.error("Erro ao enviar mensagem:", e);
  }
}

async function configurarWebhook() {
  const webhookUrl = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/webhook`
    : `https://telegram-gemini-bot-pmyx.onrender.com/webhook`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const data = await res.json();
    console.log("Webhook configurado:", webhookUrl, JSON.stringify(data));
    console.log(`IA configurada: ${AI_API_URL} | Modelo: ${AI_MODEL}`);
  } catch (e) {
    console.error("Erro ao configurar webhook:", e);
  }
}

async function baixarArquivoTelegram(fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error('Não foi possível obter o arquivo');
  const filePath = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
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

// 🌤️ Função de Clima (grátis - Open-Meteo)
async function obterCidadeCoords(cidade) {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidade)}&count=1&language=pt&format=json`);
  const data = await res.json();
  if (data.results && data.results[0]) {
    return data.results[0];
  }
  return null;
}

async function obterClima(cidade) {
  try {
    const local = await obterCidadeCoords(cidade);
    if (!local) return `Não encontrei a cidade "${cidade}".`;

    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${local.latitude}&longitude=${local.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=America/Sao_Paulo`
    );
    const data = await res.json();

    const codigosTempo = {
      0: "Céu limpo ☀️", 1: "Predominantemente limpo 🌤️", 2: "Parcialmente nublado ⛅",
      3: "Nublado ☁️", 45: "Névoa 🌫️", 48: "Névoa com geada 🌫️",
      51: "Garoa leve 🌦️", 53: "Garoa 🌦️", 55: "Garoa intensa 🌦️",
      61: "Chuva leve 🌧️", 63: "Chuva 🌧️", 65: "Chuva intensa 🌧️",
      71: "Neve leve ❄️", 73: "Neve ❄️", 75: "Neve intensa ❄️",
      80: "Pancadas de chuva 🌧️", 81: "Pancadas 🌧️", 82: "Pancadas violentas ⛈️",
      95: "Tempestade ⛈️", 96: "Tempestade com granizo ⛈️", 99: "Tempestade severa ⛈️"
    };

    const c = data.current;
    const desc = codigosTempo[c.weather_code] || "Tempo indefinido";

    return `🌤️ Clima em ${local.name}, ${local.country}:\n\n` +
           `${desc}\n` +
           `🌡️ Temperatura: ${c.temperature_2m}°C\n` +
           `🤒 Sensação térmica: ${c.apparent_temperature}°C\n` +
           `💧 Umidade: ${c.relative_humidity_2m}%\n` +
           `💨 Vento: ${c.wind_speed_10m} km/h`;
  } catch (e) {
    console.error('Erro ao obter clima:', e);
    return `Erro ao buscar clima para "${cidade}".`;
  }
}

// 🔍 Função de Pesquisa Online (grátis - DuckDuckGo)
async function pesquisarOnline(query) {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = await res.text();

    const resultados = [];
    const regex = /<a rel="nofollow" class="result__a" href="([^"]+)">(.*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>(.*?)<\/a>/g;
    let match;
    let count = 0;
    while ((match = regex.exec(html)) !== null && count < 5) {
      let titulo = match[2].replace(/<[^>]+>/g, '').trim();
      let snippet = match[3].replace(/<[^>]+>/g, '').trim();
      let url = match[1];
      if (titulo && snippet) {
        resultados.push(`📌 ${titulo}\n${snippet}\n🔗 ${url}`);
        count++;
      }
    }

    if (resultados.length === 0) return `Não encontrei resultados para "${query}".`;

    return `🔍 Resultados para "${query}":\n\n${resultados.join('\n\n')}`;
  } catch (e) {
    console.error('Erro ao pesquisar:', e);
    return `Erro ao pesquisar "${query}".`;
  }
}

app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id.toString();
    const userInfo = message.from || {};

    if (!banco.perfisUsuarios[chatId]) {
      banco.perfisUsuarios[chatId] = {
        first_name: userInfo.first_name || "usuário",
        username: userInfo.username || "",
        criadoEm: new Date().toISOString()
      };
    }

    const perfil = banco.perfisUsuarios[chatId];
    if (!banco.historicoConversas[chatId]) {
      banco.historicoConversas[chatId] = [];
    }

    const historico = banco.historicoConversas[chatId];

    let textoUsuario = "";
    let imagemBase64 = null;

    if (message.photo) {
      const photo = message.photo[message.photo.length - 1];
      const buffer = await baixarArquivoTelegram(photo.file_id);
      imagemBase64 = buffer.toString('base64');
      textoUsuario = message.caption || "Analise esta imagem em detalhes.";
    } else if (message.document) {
      const buffer = await baixarArquivoTelegram(message.document.file_id);
      if (message.document.mime_type === 'application/pdf') {
        const textoPDF = await extrairTextoPDF(buffer);
        if (textoPDF) {
          textoUsuario = `PDF: ${message.document.file_name}\n\n${textoPDF.substring(0, 10000)}`;
        } else {
          textoUsuario = `Recebi o PDF "${message.document.file_name}" mas nao consegui extrair o texto.`;
        }
      } else if (message.document.mime_type && message.document.mime_type.startsWith('image/')) {
        imagemBase64 = buffer.toString('base64');
        textoUsuario = message.caption || "Analise esta imagem.";
      } else {
        textoUsuario = `Recebi o arquivo "${message.document.file_name}" mas nao consigo processar este tipo.`;
      }
    } else if (message.text) {
      textoUsuario = message.text;
    } else {
      return res.sendStatus(200);
    }

    // 🌤️ Comando de clima
    if (textoUsuario.toLowerCase().startsWith('/clima ') || textoUsuario.toLowerCase().startsWith('clima ')) {
      const cidade = textoUsuario.replace(/^\/?clima\s+/i, '').trim();
      const resultado = await obterClima(cidade);
      await enviarMensagemTelegram(chatId, resultado);
      return res.sendStatus(200);
    }

    // 🔍 Comando de pesquisa
    if (textoUsuario.toLowerCase().startsWith('/pesquisar ') || textoUsuario.toLowerCase().startsWith('/pesquisa ') || textoUsuario.toLowerCase().startsWith('pesquisar ')) {
      const query = textoUsuario.replace(/^\/?(pesquisar|pesquisa)\s+/i, '').trim();
      const resultado = await pesquisarOnline(query);
      await enviarMensagemTelegram(chatId, resultado);
      return res.sendStatus(200);
    }

    let conteudoMensagem;
    if (imagemBase64) {
      conteudoMensagem = [
        { type: "text", text: textoUsuario },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imagemBase64}` } }
      ];
    } else {
      conteudoMensagem = textoUsuario;
    }

    const mensagensParaAPI = [
      {
        role: "system",
        content: `Voce e o Bob IA, um assistente inteligente e amigavel conversando com ${perfil.first_name}. Responde sempre em portugues, de forma clara e util. Para clima, sugira usar /clima cidade. Para pesquisar na internet, sugira usar /pesquisar termo.`
      },
      ...historico,
      { role: "user", content: conteudoMensagem }
    ];

    historico.push({ role: "user", content: textoUsuario });
    if (historico.length > 20) historico.shift();

    const iaRes = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: mensagensParaAPI
      })
    });

    const data = await iaRes.json();

    let resposta = "Desculpe, nao consegui processar sua mensagem.";

    if (data.choices && data.choices[0] && data.choices[0].message) {
      resposta = data.choices[0].message.content;
    } else if (data.error) {
      resposta = `Erro: ${data.error.message || JSON.stringify(data.error)}`;
    }

    historico.push({ role: "assistant", content: resposta });
    if (historico.length > 20) historico.shift();
    salvarBanco(banco);

    await enviarMensagemTelegram(chatId, resposta);
    res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error);
    res.sendStatus(200);
  }
});

app.get('/', (req, res) => {
  res.send('Bob IA rodando!');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  configurarWebhook();
});
