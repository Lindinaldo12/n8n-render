const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// 🔑 Configuração universal da IA — tudo via variáveis de ambiente
const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_URL = process.env.AI_API_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const AI_MODEL = process.env.AI_MODEL || "gemini-2.0-flash";

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

app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id.toString();
    const text = message.text;
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

    const mensagensParaAPI = [
      {
        role: "system",
        content: `Você é um assistente conversando com ${perfil.first_name}.`
      },
      ...historico,
      { role: "user", content: text }
    ];

    historico.push({ role: "user", content: text });
    if (historico.length > 20) historico.shift();

    // 🔑 Chamada universal — funciona com qualquer API compatível com OpenAI
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
    console.log("Resposta da IA:", JSON.stringify(data));

    let resposta = "Desculpe, não consegui processar sua mensagem.";

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
  res.send('Bot rodando! 🤖');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  configurarWebhook();
});
