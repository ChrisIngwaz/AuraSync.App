const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const { Deepgram } = require('@deepgram/sdk');
const axios = require('axios'); // Añadimos axios para Airtable

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);

// Configuración de tu App en Airtable
const AIRTABLE_CONFIG = {
  token: 'pat5n8fpBVuBZMC1n.15953e94ccf99b9501b282b9088857780fe90f19995ac0c33e1f776765fca096',
  baseId: 'appvuzy3szWjkZkp7',
  tableName: 'Citas'
};

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
          { punctuate: true, language: 'es', model: 'nova-2' }
        );
        userText = transcription.results.channels[0].alternatives[0].transcript;
      } catch (e) {
        userText = "[Error al procesar audio]";
      }
    }

    // 2. CONTEXTO DE NEGOCIO
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    const { data: listaServicios } = await supabase.from('servicios').select('*');
    const { data: listaEspecialistas } = await supabase.from('especialistas').select('*');

    const catalogoTexto = listaServicios?.map(s => `- ${s.nombre}: $${s.precio}`).join('\n') || "Servicios por definir.";
    const equipoTexto = listaEspecialistas?.map(e => `- ${e.nombre} (${e.rol})`).join('\n') || "Equipo en camino.";

    // 3. SMART PROMPT ACTUALIZADO (Mantiene tu lógica original + Extracción para Airtable)
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Coordinadora digital del local.
Tu objetivo es gestionar citas con eficiencia impecable, tono humano y persuasivo.

REGLAS DE INTERACCIÓN:
1. IDENTIDAD: Nunca digas que eres una IA.
2. CLIENTES NUEVOS: Si el sistema indica que es nuevo (Actual: ${cliente ? 'Existente' : 'Nuevo'}), solicita: Nombre, Apellido y Fecha de Nacimiento.
3. CLIENTES EXISTENTES: Saluda como ${cliente?.nombre || 'cliente'}.
4. CONCISIÓN: Máximo 2-3 oraciones.

CATÁLOGO REAL:
${catalogoTexto}

EQUIPO DISPONIBLE:
${equipoTexto}

INSTRUCCIÓN TÉCNICA OBLIGATORIA: Al final añade SIEMPRE este formato JSON:
DATA_JSON:{"nombre": "...", "servicio": "...", "fecha": "YYYY-MM-DD", "especialista": "..."}:DATA_JSON`;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ],
      temperature: 0.7,
    });

    let fullReply = aiResponse.choices[0].message.content;

    // 4. SINCRONIZACIÓN CON AIRTABLE (LA APP DEL DUEÑO)
    const jsonMatch = fullReply.match(/DATA_JSON:(.*?):DATA_JSON/s);
    if (jsonMatch) {
      try {
        const extractedData = JSON.parse(jsonMatch[1]);
        
        // Solo enviamos a Airtable si detectamos que se está agendando algo (nombre o servicio presente)
        if (extractedData.servicio !== "..." || extractedData.nombre !== "...") {
          await axios.post(`https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableName}`, {
            fields: {
              "Cliente": extractedData.nombre !== "..." ? extractedData.nombre : (cliente?.nombre || "Cliente WhatsApp"),
              "Servicio": extractedData.servicio !== "..." ? extractedData.servicio : "Consulta General",
              "Fecha": extractedData.fecha !== "..." ? extractedData.fecha : new Date().toISOString().split('T')[0],
              "Teléfono": userPhone,
              "Especialista": extractedData.especialista !== "..." ? extractedData.especialista : "Por asignar",
              "Estado": "Pendiente"
            }
          }, {
            headers: { 'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 'Content-Type': 'application/json' }
          });
          console.log("✅ Datos sincronizados en la App de Airtable");
        }
      } catch (err) {
        console.error("Error al sincronizar con Airtable:", err.response?.data || err.message);
      }
    }

    // Limpiar el JSON para que el cliente no lo vea
    const cleanReply = fullReply.replace(/DATA_JSON:.*?:DATA_JSON/s, '').trim();

    // 5. ENVÍO POR TWILIO
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
