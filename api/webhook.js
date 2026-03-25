const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const AIRTABLE_CONFIG = {
  // Asegúrate de que el token en Vercel tenga los permisos: data.records:read y data.records:write
  token: (process.env.AIRTABLE_TOKEN || 'pat5n8fpBVuBZMC1n.15953e94ccf9...').trim(), 
  baseId: 'appvuzv3szWik7kn7',
  tableName: 'Citas' // Si tu tabla en Airtable tiene otro nombre, cámbialo aquí
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');

  try {
    // 1. DATOS DE SUPABASE
    const { data: serviciosDB } = await supabase.from('servicios').select('nombre');
    const { data: equipoDB } = await supabase.from('especialistas').select('nombre, rol');
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    
    const nombreCliente = cliente?.nombre || "amigo/a";
    const catalogoTexto = serviciosDB?.map(s => `- ${s.nombre}`).join('\n') || "- Bienestar";
    const equipoTexto = equipoDB?.map(e => `- ${e.nombre} (${e.rol})`).join('\n') || "- Elena";

    // 2. AUDIO
    let textoFinal = Body || "";
    if (MediaUrl0) {
      const audioRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
        { url: MediaUrl0 }, 
        { headers: { 'Authorization': `Token 5f828847255723d84684d7c468240295cc9e0736`, 'Content-Type': 'application/json' } }
      );
      textoFinal = audioRes.data.results.channels[0].alternatives[0].transcript;
    }

    // 3. SYSTEM PROMPT (ÍNTEGRO)
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

    // 4. GPT-4O
    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: textoFinal }]
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });

    const fullReply = aiResponse.data.choices[0].message.content;
    const cleanReply = fullReply.split('DATA_JSON')[0].trim();

    // 5. AIRTABLE CON MANEJO DE PERMISOS
    const jsonMatch = fullReply.match(/DATA_JSON:(.*?):DATA_JSON/s);
    if (jsonMatch) {
      try {
        const ext = JSON.parse(jsonMatch[1]);
        const fechaFinal = (ext.fecha && ext.fecha.includes('-')) ? ext.fecha : new Date().toISOString().split('T')[0];

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${encodeURIComponent(AIRTABLE_CONFIG.tableName)}`, 
          { fields: {
            "Cliente": String(nombreCliente),
            "Servicio": ext.servicio !== "..." ? ext.servicio : "Consulta",
            "Fecha": fechaFinal,
            "Especialista": ext.especialista !== "..." ? ext.especialista : "Elena",
            "Teléfono": String(userPhone),
            "Estado": "Pendiente"
          }}, 
          { headers: { 
            'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 
            'Content-Type': 'application/json' 
          }}
        );
      } catch (err) {
        console.error("ERROR CRÍTICO AIRTABLE:", err.response?.data || err.message);
      }
    }

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send("<Response><Message>Te pido una disculpa, Chris. Tuve un pequeño inconveniente con la agenda. ¿Podrías repetirme qué necesitas?</Message></Response>");
  }
}
