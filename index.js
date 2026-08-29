const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;

const DATA_FILE = path.join(__dirname, 'database.json');
const SENHA_MESTRA = "minhasenha123";

process.on('uncaughtException', (err) => {
  console.error('ERRO NÃO TRATADO (uncaughtException):', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('REJEIÇÃO NÃO TRATADA (unhandledRejection):', reason);
});

// 🧠 Sistema de Memória Permanente e Evolutiva
function carregarBanco() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const arquivo = fs.readFileSync(DATA_FILE, 'utf8');
      const dados = JSON.parse(arquivo);
      return {
        usuariosAutenticados: new Set(dados.usuarios || []),
        perfisUsuarios: new Map(Object.entries(dados.perfis || {})),
        historicoConversas: new Map(Object.entries(dados.historicos || {}))
      };
    } catch (e) {
      console.error("Erro ao ler o banco de dados, inicializando novo:", e);
    }
  }
  return { 
    usuariosAutenticados: new Set(), 
    perfisUsuarios: new Map(), 
    historicoConversas: new Map() 
  };
}

function salvarBanco() {
  try {
    const dados = {
      usuarios: Array.from(banco.usuariosAutenticados),
      perfis: Object.fromEntries(banco.perfisUsuarios),
      historicos: Object.fromEntries(banco.historicoConversas)
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(dados, null, 2));
  } catch (e) {
    console.error("Erro ao salvar o banco de dados:", e);
  }
}

const banco = carregarBanco();

async function enviarMensagemTelegram(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text })
    });
  } catch (e) {
    console.error("Erro ao enviar mensagem para o Telegram:", e);
  }
}

app.post('/webhook', async (req, res) => {
  try {
    console.log("Mensagem recebida do Telegram:", JSON.stringify(req.body));
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id.toString();
    const text = message.text;
    const userInfo = message.from || {};

    if (!banco.perfisUsuarios.has(chatId)) {
      banco.perfisUsuarios.set(chatId, {
        firstName: userInfo.first_name || "Amigo",
        username: userInfo.username || "sem_username",
        primeiroContato: new Date().toISOString()
      });
      salvarBanco();
    }
    const perfil = banco.perfisUsuarios.get(chatId);

    if (!banco.usuariosAutenticados.has(chatId)) {
      if (text === SENHA_MESTRA) {
        banco.usuariosAutenticados.add(chatId);
        salvarBanco();
        await enviarMensagemTelegram(chatId, `Senha correta! Bem-vindo de volta, ${perfil.firstName}. Acesso autorizado e salvo permanentemente.`);
      } else {
        await enviarMensagemTelegram(chatId, "🔒 Olá! Este bot é protegido. Por favor, digite a senha de acesso para continuar:");
      }
      return res.sendStatus(200);
    }

    if (!banco.historicoConversas.has(chatId)) {
      banco.historicoConversas.set(chatId, []);
    }
    const historico = banco.historicoConversas.get(chatId);

    const mensagensParaAPI = [
      { 
        role: "system", 
        content: `Você está conversando com ${perfil.firstName} (username: @${perfil.username}). Reconheça-o pelo nome e mantenha o contexto das conversas anteriores.` 
      },
      ...historico,
      { role: "user", content: text }
    ];

    historico.push({ role: "user", content: text });
    if (historico.length > 20) {
      historico.shift();
    }

    // Chamada para a API do OpenRouter com um modelo altamente estável
    const openRouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat", 
        messages: mensagensParaAPI
      })
    });

    const data = await openRouterRes.json();
    console.log("Resposta completa do OpenRouter:", JSON.stringify(data));

    let replyText = "Desculpe, ocorreu um erro ao gerar a resposta.";

    if (data.choices && data.choices[0]?.message?.content) {
      replyText = data.choices[0].message.content;
      historico.push({ role: "assistant", content: replyText });
      salvarBanco();
    } else if (data.error) {
      replyText = `Erro do OpenRouter: ${data.error.message}`;
    }

    await enviarMensagemTelegram(chatId, replyText);
    res.sendStatus(200);
  } catch (error) {
    console.error('Erro crítico no processamento do webhook:', error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('Bot com Memória Permanente e Evolutiva rodando com sucesso!');
});

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  if (TELEGRAM_TOKEN) {
    const webhookUrl = `https://telegram-gemini-bot-pmyx.onrender.com/webhook`;
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`);
      console.log(`Webhook configurado para: ${webhookUrl}`);
    } catch (e) {
      console.error("Erro ao configurar o webhook do Telegram:", e);
    }
  }
});
