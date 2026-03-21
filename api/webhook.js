// Este es el "Cerebro" de AuraSync que conecta Twilio, Deepgram, Supabase y OpenAI
const { Deepgram } = require('@deepgram/sdk');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const twilio = require('twilio');

// Conectamos las herramientas usando tus "llaves" secretas
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

export default async function handler(req, res) {
  // Solo aceptamos mensajes que vienen de Twilio (POST)
  if (req.method !== 'POST') return res.status(405).send('Método no permitido');

  const { From, Body, MediaUrl0 } = req.body; 
  const userPhone = From.replace('whatsapp:', ''); // Quitamos el texto extra del número

  try {
    // PASO A: ¿El cliente envió un audio? (Oído del asistente)
    let textToProcess = Body || "";
    if (MediaUrl0) {
      // Deepgram escucha el audio y lo escribe por nosotros
      const response = await deepgram.transcription.preRecorded({ url: MediaUrl0 }, { language: 'es', punctuate: true });
      textToProcess = response.results.channels[0].alternatives[0].transcript;
    }

    // PASO B: Buscar al cliente en tu base de datos (Memoria)
    let { data: client } = await supabase.from('clients').select('*').eq('phone', userPhone).single();

    // PASO C: Consultar al "Smart Prompt" (Personalidad Humana)
    // Aquí es donde la IA decide qué decir basándose en si es nuevo o antiguo
    const systemInstruction = client 
      ? `Eres la asistente de AuraSync. Saluda a ${client.name}. Revisa sus citas y ayúdale a agendar una nueva con nuestro staff.` 
      : `Eres la asistente de AuraSync. Este es un CLIENTE NUEVO. Preséntate con calidez, NO digas que eres una IA, y pide su Nombre, Apellido y Fecha de Nacimiento.`;

    const aiCompletion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: textToProcess }
      ],
    });

    const finalResponse = aiCompletion.choices[0].message.content;

    // PASO D: Enviar la respuesta de vuelta a WhatsApp
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: From,
      body: finalResponse
    });

    return res.status(200).send('Mensaje procesado');

  } catch (error) {
    console.error("Error en el flujo:", error);
    return res.status(500).send('Error interno');
  }
}
