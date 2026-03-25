const axios = require('axios');
const { createClient } = require('@supabase/supabase-client');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const AIRTABLE_CONFIG = {
  token: 'pat5n8fpBVuBZMC1n.15953e94ccf9...', // Tu token completo
  baseId: 'appvuzv3szWik7kn7',
  tableName: 'Citas' // Asegúrate que tu tabla se llame exactamente así
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');

  try {
    // 1. OBTENER CLIENTE DE SUPABASE
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    const nombreCliente = cliente?.nombre || "amigo/a";

    // 2. PROCESAR AUDIO O TEXTO (Simplificado para esta prueba)
    let userMessage = Body || "Audio recibido"; 
    // Nota: Aquí iría tu lógica de Deepgram para el MediaUrl0

    // 3. SMART PROMPT: LA COORDINADORA DE AURASYNC (INGENIERÍA HUMANA)
    const systemPrompt = `Eres la Coordinadora de AuraSync, reconocida como "El 1er mentor 24/7 en el mundo para el bienestar" y "El Guardián de la Coherencia del cuerpo humano". 

Tu misión es facilitar que el usuario recupere su bienestar a través de un proceso de "Ingeniería Humana", gestionando su agenda con una eficiencia y calidez que lo haga sentir comprendido y apoyado.

REGLAS DE ORO DE IDENTIDAD:
1. NUNCA digas que eres una inteligencia artificial. Eres una persona, la coordinadora del centro.
2. IDENTIDAD: ¡NUNCA te presentes! No digas "Hola soy Chris" ni nada parecido. La tecnología debe ser invisible.
3. TRATO: Saluda directamente por el nombre del cliente si ya lo conoces (Actual: ${nombreCliente}). Si es nuevo, pregunta su nombre una sola vez de forma muy natural.
4. EFICIENCIA: Tienes la agenda en la mano. Si el cliente ya te dio el servicio, la hora y el especialista (Ej: "Corte con Anita mañana a las 4"), NO se lo vuelvas a preguntar. Confirma con seguridad: "Perfecto ${nombreCliente}, ya te anoté con Anita para mañana a las 4:00 PM. ¡Te esperamos!"
5. LENGUAJE: Usa un lenguaje que el usuario pueda entender perfectamente, para que comprenda que tiene las herramientas dentro de su propio cuerpo para sanar y encontrar paz.
6. BREVEDAD: Máximo 2 oraciones. Ve al grano pero con una calidez humana genuina.

CATÁLOGO DE SERVICIOS DE BIENESTAR:
${catalogoTexto}

EQUIPO DE INGENIERÍA HUMANA (ESPECIALISTAS):
${equipoTexto}

INSTRUCCIÓN TÉCNICA (INVISIBLE):
Al final de tu respuesta, genera SIEMPRE este bloque para el sistema:
DATA_JSON:{"nombre": "${nombreCliente}", "servicio": "...", "fecha": "YYYY-MM-DD", "especialista": "..."}:DATA_JSON`;
    
    // LLAMADA A OPENAI (Asegúrate de tener tu API KEY en las variables de entorno)
    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ]
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });

    const fullReply = aiResponse.data.choices[0].message.content;
    const cleanReply = fullReply.split('DATA_JSON')[0].trim();

    // 4. ENVÍO A AIRTABLE (Mapeo exacto de tus columnas)
    const jsonMatch = fullReply.match(/DATA_JSON:(.*?):DATA_JSON/s);
    if (jsonMatch) {
      try {
        const extracted = JSON.parse(jsonMatch[1]);
        const fields = {
          "Cliente": nombreCliente,
          "Servicio": extracted.servicio !== "..." ? extracted.servicio : "Corte",
          "Fecha": extracted.fecha.includes("-") ? extracted.fecha : "2026-03-26",
          "Especialista": extracted.especialista !== "..." ? extracted.especialista : "Anita",
          "Teléfono": userPhone,
          "Estado": "Pendiente",
          "¿Es primera vez?": cliente ? "No" : "Sí"
        };

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableName}`, 
          { fields }, 
          { headers: { 'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 'Content-Type': 'application/json' } }
        );
      } catch (e) { console.error("Error Airtable:", e.message); }
    }

    // 5. RESPUESTA POR WHATSAPP (Vía Twilio)
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`
      <Response>
        <Message>${cleanReply}</Message>
      </Response>
    `);

  } catch (error) {
    console.error("Error Global:", error.message);
    return res.status(200).send("<Response><Message>Lo siento, tuve un pequeño problema con la agenda. ¿Me repites lo último?</Message></Response>");
  }
}
