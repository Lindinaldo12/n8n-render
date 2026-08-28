const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) return res.sendStatus(200);

    const chatId = message.chat.id;
    const text = message.text;

    // Chamada direta para a API do Gemini (v1beta)
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: text }] }]
      })
    });

    const geminiData = await geminiRes.json();
    const replyText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "Desculpe, ocorreu um erro ao gerar a resposta.";

    // Envia a resposta de volta para o Telegram
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: replyText
      })
    });

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro no processamento:', error);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('Bot Telegram com Gemini rodando com sucesso!');
});

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  
  // Configura automaticamente o Webhook do Telegram usando a URL do Render
  if (process.env.RENDER_EXTERNAL_URL && TELEGRAM_TOKEN) {
    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook/${TELEGRAM_TOKEN}`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${webhookUrl}`);
    console.log(`Webhook configurado para: ${webhookUrl}`);
  }
});
