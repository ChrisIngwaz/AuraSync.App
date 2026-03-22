const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const { Deepgram } = require('@deepgram/sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const { From, Body, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');

  try {
    // 1. PROCESAR AUDIO O TEXTO
    let userText = Body || "";
    if (MediaUrl0) {
      const transcription = await deepgram.transcription.preRecorded(
        { url: MediaUrl0 },
        { punctuate: true, language: 'es' }
      );
      userText = transcription.results.channels[0].alternatives[0].transcript;
    }

    // 2. LEER BASE DE DATOS (Servicios y Especialistas)
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    const { data: listaServicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    const { data: listaEspecialistas } = await supabase.from('especialistas').select('nombre, especialidad');

    // Construir el catálogo para la IA
    const catalogoTexto = listaServicios?.map(s => `- ${s.nombre}: $${s.precio} (${s.duracion} min)`).join('\n') || "No hay servicios cargados.";
    const equipoTexto = listaEspecialistas?.map(e => `- ${e.nombre}: ${e.especialidad}`).join('\n') || "No hay especialistas cargados.";

    // 3. SMART PROMPT CON DATOS REALES
    const systemPrompt = `Eres la Asistente de AuraSync. Coordinadora profesional.
    
CATÁLOGO REAL DE SERVICIOS:
${catalogoTexto}

EQUIPO DISPONIBLE:
${equipoTexto}

REGLAS:
- No inventes servicios ni precios. Usa solo los de la lista arriba.
- Si preguntan por servicios, lístalos de forma persuasiva y breve.
- Cliente actual: ${cliente?.nombre || 'Nuevo'}.
- No digas que eres una IA.

INSTRUCCIÓN TÉCNICA: Al final añade SIEMPRE:
DATA_JSON:{"nombre": "...", "servicio_id": "...", "fecha_cita": "..."}:DATA_JSON`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ],
    });

    let fullReply = aiResponse.choices[0].message.content;
    fullReply = fullReply.replace(/DATA_JSON:.*?:DATA_JSON/s, '').trim();

    // 4. ENVÍO
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: From,
      body: fullReply
    });

    return res.status(200).send('OK');
  } catch (error) {
    console.error("Error AuraSync:", error);
    return res.status(200).send('OK');
  }
}
