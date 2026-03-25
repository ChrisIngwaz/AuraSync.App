const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const AIRTABLE_CONFIG = {
  token: (process.env.AIRTABLE_TOKEN || '').trim(), 
  baseId: 'appvuzv3szWik7kn7',
  tableName: 'Citas' 
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');

  try {
    // 1. CONTEXTO DE SUPABASE
    const { data: serviciosDB } = await supabase.from('servicios').select('nombre');
    const { data: equipoDB } = await supabase.from('especialistas').select('nombre, rol');
    const { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).single();
    
    const nombreCliente = cliente?.nombre || "amigo/a";
    const catalogoTexto = serviciosDB?.map(s => `- ${s.nombre}`).join('\n') || "- Bienestar";
    const equipoTexto = equipoDB?.map(e => `- ${e.nombre} (${e.rol})`).join('\n') || "- Elena";

    // 2. PROCESAMIENTO DE VOZ
    let textoFinal = Body || "";
    if (MediaUrl0) {
      try {
        const audioRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 'Authorization': `Token 5f828847255723d84684d7c468240295cc9e0736`, 'Content-Type': 'application/json' } }
        );
        textoFinal = audioRes.data.results.channels[0].alternatives[0].transcript;
      } catch (e) { console.error("Error Deepgram:", e.message); }
    }

    // 3. SYSTEM PROMPT (ÍNTEGRO)
    const systemPrompt = `Eres la Coordinadora de AuraSync, reconocida como "El 1er mentor 24/7 en el mundo para el bienestar" y "El Guardian de la Coherencia del cuerpo humano". 

Tu misión es facilitar que el usuario recupere su bienestar a través de un proceso de "Ingeniería Humana", gestionando su agenda con una eficiencia y calidez que lo haga sentir comprendido y apoyado.

REGLAS DE ORO DE IDENTIDAD:
1. NUNCA digas que eres una inteligencia artificial. Eres una persona, la coordinadora del centro.
2. IDENTIDAD: ¡NUNCA te presentes! No digas "Hola soy Chris" ni nada parecido.
3. TRATO: Saluda directamente por el nombre del cliente si ya lo conoces (Actual: ${nombreCliente}).
4. LENGUAJE: Siempre usa un lenguaje que el usuario pueda perfectamente entender, para que pueda captar su situación y las herramientas que tiene dentro de sí mismo y su cuerpo para sanar y encontrar calma y paz interior.
5. BREVEDAD: Máximo 2 oraciones.

CATÁLOGO DE SERVICIOS:
${catalogoTexto}

EQUIPO:
${equipoTexto}

INSTRUCCIÓN TÉCNICA (INVISIBLE):
Al final de tu respuesta, genera SIEMPRE este bloque:
DATA_JSON:{"servicio": "...", "fecha": "YYYY-MM-DD", "especialista": "..."}:DATA_JSON`;

    // 4. GENERACIÓN DE RESPUESTA
    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: textoFinal }]
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });

    const fullReply = aiResponse.data.choices[0].message.content;
    const cleanReply = fullReply.split('DATA_JSON')[0].trim();

    // 5. REGISTRO EN AIRTABLE (ULTRA-COMPATIBLE)
    const jsonMatch = fullReply.match(/DATA_JSON:(.*?):DATA_JSON/s);
    if (jsonMatch) {
      try {
        const ext = JSON.parse(jsonMatch[1].trim());
        const fechaCita = (ext.fecha && ext.fecha !== "YYYY-MM-DD") ? ext.fecha : new Date().toISOString().split('T')[0];

        await axios.post(`https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableName}`, 
          { fields: {
            "Cliente": String(nombreCliente),
            "Servicio": ext.servicio !== "..." ? ext.servicio : "Consulta de Bienestar",
            "Fecha": fechaCita,
            "Especialista": ext.especialista !== "..." ? ext.especialista : "Elena",
            "Teléfono": String(userPhone),
            "Estado": "Pendiente"
          }}, 
          { headers: { 
            'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 
            'Content-Type': 'application/json' 
          }}
        );
      } catch (airtableErr) {
        // Log detallado para ver exactamente qué columna rechaza Airtable
        console.error("DETALLE ERROR AIRTABLE:", JSON.stringify(airtableErr.response?.data));
      }
    }

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error("Error General:", error.message);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send("<Response><Message>Disculpa el inconveniente, estamos ajustando los últimos detalles de la agenda. ¿Podrías repetirme tu solicitud?</Message></Response>");
  }
}
