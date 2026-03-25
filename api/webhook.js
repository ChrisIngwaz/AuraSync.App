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

    // 2. CONTEXTO Y MEMORIA (Historial de mensajes)
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    
    // Traemos los últimos 4 mensajes para que no se enrede
    const { data: historial } = await supabase
      .from('mensajes') // Asegúrate de tener esta tabla o quita esta parte si prefieres solo prompt
      .select('contenido, rol')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(4);

    const historialTexto = historial?.reverse().map(m => `${m.rol}: ${m.contenido}`).join('\n') || "";

    // 3. SMART PROMPT CON MEMORIA
    const systemPrompt = `Eres la Coordinadora de AuraSync. No eres una IA, eres la persona encargada de que el local funcione a la perfección. 

Tu tono es cálido, profesional y sumamente eficiente. Hablas con la seguridad de quien tiene la agenda abierta frente a sus ojos.

REGLAS DE ORO DE HUMANIDAD:
1. IDENTIDAD: Jamás te presentes ni digas "Soy la asistente". Saluda directamente como lo haría una persona que ya está en medio de una gestión.
2. RECONOCIMIENTO: Saluda por su nombre (Actual: ${cliente?.nombre || 'amigo/a'}). Si el nombre es "Desconocido", pregunta "¿Con quién tengo el gusto?" de forma natural.
3. DETECCIÓN DE DATOS: Si el usuario ya te dio el servicio, la hora y el especialista, NO se los vuelvas a preguntar. Pasa directamente a confirmar con un: "Perfecto ${cliente?.nombre || ''}, te espero mañana a las 4pm con Anita. Ya te anoté."
4. BREVEDAD HUMANA: No uses frases robóticas. Máximo 2 oraciones.
5. MEMORIA OPERATIVA: Si el usuario te envía varios audios seguidos, une la información. Si en uno dijo "mañana" y en otro "con Anita", entiéndelo como una sola solicitud.

CATÁLOGO DE SERVICIOS:
${catalogoTexto}

EQUIPO DISPONIBLE:
${equipoTexto}

INSTRUCCIÓN TÉCNICA (INVISIBLE PARA EL USUARIO):
Extrae los datos y genera el JSON al final. Si falta un dato, pon "..." en ese campo.
DATA_JSON:{"nombre": "${cliente?.nombre || "..."}", "servicio": "...", "fecha": "YYYY-MM-DD", "especialista": "..."}:DATA_JSON`;  
    
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
