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
    // 1. PROCESAR AUDIO (Deepgram) O TEXTO
    let userText = Body || "";
    if (MediaUrl0) {
      try {
        // Deepgram es 3x más rápido que otros servicios para notas de voz
        const transcription = await deepgram.transcription.preRecorded(
          { url: MediaUrl0 },
          { punctuate: true, language: 'es', model: 'nova-2' }
        );
        userText = transcription.results.channels[0].alternatives[0].transcript;
      } catch (e) {
        console.error("Error Transcripción:", e);
        userText = "[Error al procesar audio, pide al cliente que escriba]";
      }
    }

    // 2. CONTEXTO DE NEGOCIO (Supabase)
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    const { data: listaServicios } = await supabase.from('servicios').select('*');
    const { data: listaEspecialistas } = await supabase.from('especialistas').select('*');

    const catalogoTexto = listaServicios?.map(s => `- ${s.nombre}: $${s.precio}`).join('\n') || "Servicios por definir.";
    const equipoTexto = listaEspecialistas?.map(e => `- ${e.nombre} (${e.rol})`).join('\n') || "Equipo en camino.";

    // 3. SMART PROMPT ACTUALIZADO (Ventas y Agendamiento)
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Coordinadora digital del local.
Tu objetivo es gestionar citas con eficiencia impecable, tono humano y persuasivo.

REGLAS DE INTERACCIÓN:
1. IDENTIDAD: Nunca digas que eres una IA.
2. CLIENTES NUEVOS: Si el sistema indica que es nuevo (Actual: ${cliente ? 'Existente' : 'Nuevo'}), saluda con calidez y solicita obligatoriamente: Nombre, Apellido y Fecha de Nacimiento. No agendes sin estos datos.
3. CLIENTES EXISTENTES: Saluda como ${cliente?.nombre || 'cliente'}. Ofrece servicios según el catálogo.
4. CIERRE DE VENTAS: Si hay duda, resalta beneficios (calidad, bienestar).
5. CONCISIÓN: Respuestas cortas para WhatsApp. Máximo 2-3 oraciones.

CATÁLOGO REAL:
${catalogoTexto}

EQUIPO DISPONIBLE:
${equipoTexto}

POLÍTICA: Cancelación mínima 4 horas antes.

INSTRUCCIÓN TÉCNICA: Al final añade SIEMPRE:
DATA_JSON:{"nombre": "...", "fecha_nacimiento": "...", "email": "...", "notas_bienestar": "..."}:DATA_JSON`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ],
      temperature: 0.7,
    });

    let fullReply = aiResponse.choices[0].message.content;

    // Extraer JSON para guardar datos en segundo plano si es necesario
    const jsonMatch = fullReply.match(/DATA_JSON:(.*?):DATA_JSON/s);
    if (jsonMatch) {
      const extractedData = JSON.parse(jsonMatch[1]);
      // Aquí podrías actualizar la tabla 'clientes' en Supabase automáticamente
      if (!cliente && extractedData.nombre !== "...") {
         await supabase.from('clientes').insert([{ 
           telefono: userPhone, 
           nombre: extractedData.nombre,
           fecha_nacimiento: extractedData.fecha_nacimiento 
         }]);
      }
    }

    // Limpiar el JSON de la respuesta que ve el cliente
    const cleanReply = fullReply.replace(/DATA_JSON:.*?:DATA_JSON/s, '').trim();

    // 4. ENVÍO POR TWILIO
    await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_NUMBER}`,
      to: From,
      body: cleanReply
    });

    return res.status(200).send('OK');
  } catch (error) {
    console.error("Error Crítico AuraSync:", error);
    return res.status(200).send('OK');
  }
}
