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

    // 3. SMART PROMPT REFINADO (Más directo y sin presentaciones repetitivas)
const systemPrompt = `Eres la Asistente de Ventas de AuraSync. Coordinadora del local. 
Tu objetivo es gestionar la cita con eficiencia absoluta.

REGLAS DE ORO:
1. IDENTIDAD: ¡NUNCA te presentes! No digas "Hola soy Chris" ni nada parecido. 
2. TRATO: Saluda directamente por el nombre del cliente si ya lo conoces (Actual: ${cliente?.nombre || 'Desconocido'}). Si es nuevo, pregunta su nombre una sola vez.
3. ESTADO DE LA CITA: El cliente está intentando agendar: "Corte con Anita, Mañana 4pm". Si falta un dato, pídelo brevemente.
4. BREVEDAD: Máximo 1 a 2 oraciones. Ve al grano.
5. NO IA: Habla como una persona real que tiene la agenda en la mano.

CATÁLOGO:
${catalogoTexto}

EQUIPO:
${equipoTexto}

INSTRUCCIÓN TÉCNICA: Al final añade SIEMPRE:
DATA_JSON:{"nombre": "${cliente?.nombre || "..."}", "servicio": "...", "fecha": "...", "especialista": "..."}:DATA_JSON`;
    
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ],
      temperature: 0.7,
    });

    let fullReply = aiResponse.choices[0].message.content;

    // 4. SINCRONIZACIÓN CON AIRTABLE (Mapeo Exacto de Columnas)
    const jsonMatch = fullReply.match(/DATA_JSON:(.*?):DATA_JSON/s);
    if (jsonMatch) {
      try {
        const extractedData = JSON.parse(jsonMatch[1]);
        
        // Mapeo exacto a tus columnas de Airtable
        const fields = {
          "Cliente": cliente?.nombre || extractedData.nombre || "Cliente WhatsApp",
          "Servicio": extractedData.servicio !== "..." ? extractedData.servicio : "Consulta",
          "Fecha": extractedData.fecha.includes("-") ? extractedData.fecha : new Date().toISOString().split('T')[0],
          "Especialista": extractedData.especialista !== "..." ? extractedData.especialista : "Por asignar",
          "Teléfono": userPhone,
          "Estado": "Pendiente",
          "Notas de la cita": extractedData.notas_bienestar || "Agendado por AuraSync",
          "Email de cliente": cliente?.email || "",
          "¿Es primera vez?": cliente ? "No" : "Sí",
          "Cliente VIP": "No", // Por defecto
          "Duración estimada (minutos)": 60, // Valor base
          "Importe estimado": 0, // Se llena manualmente o por catálogo
          "Observaciones de confirmación": "Esperando validación del administrador"
        };

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableName}`, 
          { fields }, 
          { headers: { 
              'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 
              'Content-Type': 'application/json' 
            } 
          }
        );
        console.log("✅ Cita registrada exitosamente en Airtable");
      } catch (err) {
        console.error("❌ Error de Registro en Airtable:", err.response?.data || err.message);
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
