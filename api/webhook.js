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
      try {
        const transcription = await deepgram.transcription.preRecorded(
          { url: MediaUrl0 },
          { punctuate: true, language: 'es' }
        );
        userText = transcription.results.channels[0].alternatives[0].transcript;
      } catch (e) {
        userText = "[Audio no transcrito]";
      }
    }

    // 2. LEER BASE DE DATOS (Servicios y Especialistas)
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    const { data: listaServicios } = await supabase.from('servicios').select('*');
    const { data: listaEspecialistas } = await supabase.from('especialistas').select('*');

    // CONSTRUIR EL CONTEXTO CON LA COLUMNA "ROL"
    const catalogoTexto = listaServicios?.map(s => `- ${s.nombre}: $${s.precio}`).join('\n') || "No hay servicios.";
    const equipoTexto = listaEspecialistas && listaEspecialistas.length > 0 
      ? listaEspecialistas.map(e => `- ${e.nombre} (${e.rol})`).join('\n') 
      : "No hay especialistas registrados.";

    // 3. SMART PROMPT ORIGINAL
    const systemPrompt = `Eres la Asistente de AuraSync. Coordinadora profesional.
    
CATÁLOGO REAL:
${catalogoTexto}

EQUIPO DISPONIBLE:
${equipoTexto}

REGLAS:
- Si preguntan por especialistas, usa la lista de arriba. Ejemplo: Anita hace Corte de Cabello.
- Si el cliente es ${cliente?.nombre || 'Nuevo'}, pide sus datos.
- No digas que eres una IA.

INSTRUCCIÓN TÉCNICA: Al final añade SIEMPRE:
DATA_JSON:{"nombre": "...", "servicio_id": "...", "especialista_id": "...", "fecha_cita": "..."}:DATA_JSON`;

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
