const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Memória para registrar os usuários que já acertaram a senha
const usuariosAutenticados = new Set();
const SENHA_MESTRA = "minhasenha123";

// Função auxiliar para enviar mensagens no Telegram
async function enviarMensagemTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

app.post('/webhook', async (req, res) => {
  try {
    console.log("Mensagem recebida do Telegram:", JSON.stringify(req.body));
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;

    // 1. Verifica se o usuário já foi autenticado nesta sessão
    if (!usuariosAutenticados.has(chatId)) {
      if (text === SENHA_MESTRA) {
        usuariosAutenticados.add(chatId);
        await enviarMensagemTelegram(chatId, "Senha correta! Acesso autorizado. Como posso te ajudar?");
      } else {
        await enviarMensagemTelegram(chatId, "🔒 Olá! Este bot é protegido. Por favor, digite a senha de acesso para continuar:");
      }
      return res.sendStatus(200);
    }

    // 2. Se já estiver autenticado, envia a mensagem normalmente para o Gemini (comportamento geral)
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: text }] }]
      })
    });

    const geminiData = await geminiRes.json();
    console.log("Resposta completa do Gemini:", JSON.stringify(geminiData));

    let replyText = "Desculpe, ocorreu um erro ao gerar a resposta.";

    if (geminiData.candidates && geminiData.candidates[0]?.content?.parts?.[0]?.text) {
      replyText = geminiData.candidates[0].content.parts[0].text;
    } else if (geminiData.error) {
      replyText = `Erro da API Gemini: ${geminiData.error.message}`;
    }

    // Envia a resposta de volta para o usuário reconhecido
    await enviarMensagemTelegram(chatId, replyText);

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro crítico no processamento:', error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('Bot Telegram com Gemini rodando com sucesso!');
});

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  if (TELEGRAM_TOKEN) {
    const webhookUrl = `https://telegram-gemini-bot-pmyx.onrender.com/webhook`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`);
    console.log(`Webhook configurado para: ${webhookUrl}`);
  }
});
