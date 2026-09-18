require('dotenv').config();
const express = require('express');
const { Telegraf } = require('telegraf');
const { GoogleGenAI } = require('@google/genai');
const pdfParse = require('pdf-parse');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function getTelegramFileUrl(fileId) {
  const fileLink = await bot.telegram.getFileLink(fileId);
  return fileLink.href;
}

async function getFileBuffer(url) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

bot.start((ctx) => {
  ctx.reply('👋 Olá! Sou seu assistente inteligente com Gemini.\n\nEnvie texto, fotos, áudios, arquivos PDF ou links para eu analisar!');
});

bot.help((ctx) => {
  ctx.reply(
    '📌 *Como me utilizar:*\n\n' +
    '• *Texto:* Envie qualquer dúvida ou mensagem.\n' +
    '• *Imagens:* Envie uma foto (com ou sem legenda).\n' +
    '• *Áudio:* Envie uma mensagem de voz ou arquivo MP3/OGG.\n' +
    '• *PDF:* Envie um documento em formato .pdf.\n' +
    '• *Busca Web:* Use o comando `/buscar <sua pesquisa>`.\n',
    { parse_mode: 'Markdown' }
  );
});

bot.command('buscar', async (ctx) => {
  const query = ctx.message.text.replace('/buscar', '').trim();
  if (!query) return ctx.reply('Por favor, informe o termo para busca. Exemplo: `/buscar notícias sobre tecnologia hoje`', { parse_mode: 'Markdown' });

  await ctx.sendChatAction('typing');
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: query,
      config: {
        tools: [{ googleSearch: {} }]
      }
    });
    await ctx.reply(response.text || 'Não encontrei resultados.');
  } catch (err) {
    console.error('Erro na busca:', err);
    await ctx.reply('❌ Ocorreu um erro ao realizar a busca na web.');
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  await ctx.sendChatAction('typing');

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: text
    });
    await ctx.reply(response.text);
  } catch (err) {
    console.error('Erro em texto:', err);
    await ctx.reply('❌ Ocorreu um erro ao processar sua mensagem.');
  }
});

bot.on('photo', async (ctx) => {
  await ctx.sendChatAction('typing');
  try {
    const photos = ctx.message.photo;
    const highestResPhoto = photos[photos.length - 1];
    const fileUrl = await getTelegramFileUrl(highestResPhoto.file_id);
    const buffer = await getFileBuffer(fileUrl);

    const caption = ctx.message.caption || 'Descreva e analise esta imagem em detalhes.';

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: buffer.toString('base64')
          }
        },
        caption
      ]
    });

    await ctx.reply(response.text);
  } catch (err) {
    console.error('Erro em foto:', err);
    await ctx.reply('❌ Erro ao analisar a imagem.');
  }
});

bot.on(['voice', 'audio'], async (ctx) => {
  await ctx.sendChatAction('typing');
  try {
    const isVoice = !!ctx.message.voice;
    const fileId = isVoice ? ctx.message.voice.file_id : ctx.message.audio.file_id;
    const mimeType = isVoice ? 'audio/ogg' : (ctx.message.audio.mime_type || 'audio/mp3');

    const fileUrl = await getTelegramFileUrl(fileId);
    const buffer = await getFileBuffer(fileUrl);

    const caption = ctx.message.caption || 'Transcreva este áudio e faça um resumo dos pontos principais.';

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            mimeType: mimeType,
            data: buffer.toString('base64')
          }
        },
        caption
      ]
    });

    await ctx.reply(response.text);
  } catch (err) {
    console.error('Erro em áudio:', err);
    await ctx.reply('❌ Erro ao processar o áudio.');
  }
});

bot.on('document', async (ctx) => {
  const doc = ctx.message.document;

  if (doc.mime_type !== 'application/pdf') {
    return ctx.reply('No momento só consigo processar documentos em formato PDF.');
  }

  await ctx.sendChatAction('typing');
  try {
    const fileUrl = await getTelegramFileUrl(doc.file_id);
    const buffer = await getFileBuffer(fileUrl);

    const pdfData = await pdfParse(buffer);
    const pdfText = pdfData.text.slice(0, 30000);

    const caption = ctx.message.caption || 'Resuma o conteúdo principal deste documento PDF:';

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `${caption}\n\n--- Conteúdo extraído do PDF ---\n${pdfText}`
    });

    await ctx.reply(response.text);
  } catch (err) {
    console.error('Erro em PDF:', err);
    await ctx.reply('❌ Erro ao ler o arquivo PDF.');
  }
});

cron.schedule('0 9 * * *', () => {
  console.log('[CRON] Executando tarefa agendada diária...');
});

app.get('/', (req, res) => {
  res.send('🤖 Bot Telegram + Gemini está ativo!');
});

app.listen(PORT, () => {
  console.log(`Servidor Express rodando na porta ${PORT}`);
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

