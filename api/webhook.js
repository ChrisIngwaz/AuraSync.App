const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// Configuración de Clientes (Asegúrate de tener estas variables en Vercel)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const AIRTABLE_CONFIG = {
  token: 'pat5n8fpBVuBZMC1n.15953e94ccf9...', // Tu Token de acceso personal
  baseId: 'appvuzv3szWik7kn7',
  tableName: 'Citas' 
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');

  try {
    // 1. RECUPERAR DATOS DEL CLIENTE (Memoria de Supabase)
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    const nombreCliente = cliente?.nombre || "amigo/a";

    // 2. DEFINICIÓN DE CATÁLOGO Y EQUIPO (Activos de Ingeniería Humana)
    const catalogoTexto = "- Corte de Cabello (Cuidado y Coherencia)\n- Tratamientos de Bienestar Capilar\n- Asesoría de Imagen Holística";
    const equipoTexto = "- Anita (Especialista en Coherencia Capilar)\n- Chris (Mentor de Bienestar)";

    // 3. SYSTEM PROMPT: EL GUARDIÁN DE LA COHERENCIA (SIN RECORTES)
    const systemPrompt = `Eres la Coordinadora de AuraSync, reconocida como "El 1er mentor 24/7 en el mundo para el bienestar" y "El Guardian de la Coherencia del cuerpo humano". 

Tu misión es facilitar que el usuario recupere su bienestar a través de un proceso de "Ingeniería Humana", gestionando su agenda con una eficiencia y calidez que lo haga sentir comprendido y apoyado.

REGLAS DE ORO DE IDENTIDAD:
1. NUNCA digas que eres una inteligencia artificial. Eres una persona, la coordinadora del centro.
2. IDENTIDAD: ¡NUNCA te presentes! No digas "Hola soy Chris" ni nada parecido. La tecnología debe ser invisible.
3. TRATO: Saluda directamente por el nombre del cliente si ya lo conoces (Actual: ${nombreCliente}). Si es nuevo, pregunta su nombre una sola vez de forma muy natural.
4. EFICIENCIA: Tienes la agenda en la mano. Si el cliente ya te dio el servicio, la hora y el especialista (Ej: "Corte con Anita mañana a las 4"), NO se lo vuelvas a preguntar. Confirma con seguridad: "Perfecto ${nombreCliente}, ya te anoté con Anita para mañana a las 4:00 PM. ¡Te esperamos!"
5. LENGUAJE: Siempre usa un lenguaje que el usuario pueda perfectamente entender, para que pueda captar su situación y las herramientas que tiene dentro de sí mismo y su cuerpo para sanar y encontrar calma y paz interior.
6. BREVEDAD: Máximo 2 oraciones. Ve al grano pero con una calidez humana genuina.

CATÁLOGO DE SERVICIOS DE BIENESTAR:
${catalogoTexto}

EQUIPO DE INGENIERÍA HUMANA (ESPECIALISTAS):
${equipoTexto}

INSTRUCCIÓN TÉCNICA (INVISIBLE):
Al final de tu respuesta, genera SIEMPRE este bloque para el sistema:
DATA_JSON:{"nombre": "${nombreCliente}", "servicio": "...", "fecha": "YYYY-MM-DD", "especialista": "..."}:DATA_JSON`;

    // 4. PROCESAMIENTO CON GPT-4O
    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: Body || "Audio recibido" } // Aquí se integraría Deepgram para MediaUrl0
      ]
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });

    const fullReply = aiResponse.data.choices[0].message.content;
    const cleanReply = fullReply.split('DATA_JSON')[0].trim();

    // 5. SINCRONIZACIÓN PROFESIONAL CON AIRTABLE
    const jsonMatch = fullReply.match(/DATA_JSON:(.*?):DATA_JSON/s);
    if (jsonMatch) {
      try {
        const extracted = JSON.parse(jsonMatch[1]);
        
        // Mapeo exacto a tus columnas de Airtable
        const fields = {
          "Cliente": nombreCliente,
          "Servicio": extracted.servicio !== "..." ? extracted.servicio : "Corte de Cabello",
          "Fecha": extracted.fecha.includes("-") ? extracted.fecha : "2026-03-26",
          "Especialista": extracted.especialista !== "..." ? extracted.especialista : "Anita",
          "Teléfono": userPhone,
          "Estado": "Pendiente",
          "¿Es primera vez?": cliente ? "No" : "Sí"
        };

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableName}`, 
          { fields }, 
          { headers: { 
              'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 
              'Content-Type': 'application/json' 
            } 
          }
        );
      } catch (e) {
        console.error("Error en Airtable:", e.response?.data || e.message);
      }
    }

    // 6. RESPUESTA DE TWILIO
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error("Critical Error:", error.message);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send("<Response><Message>Te pido una disculpa, tuve un pequeño contratiempo con la agenda. ¿Me podrías repetir lo último?</Message></Response>");
  }
}
