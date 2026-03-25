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
  
  // Logs de debugging esenciales
  console.log('📞 Webhook recibido:', { userPhone, hasAudio: !!MediaUrl0, textLength: Body?.length });

  try {
    // 1. CONTEXTO DE SUPABASE
    const [{ data: serviciosDB }, { data: equipoDB }, { data: cliente }] = await Promise.all([
      supabase.from('servicios').select('nombre'),
      supabase.from('especialistas').select('nombre, rol'),
      supabase.from('clientes').select('*').eq('telefono', userPhone).single()
    ]);
    
    const nombreCliente = cliente?.nombre || "amigo/a";
    const catalogoTexto = serviciosDB?.map(s => `- ${s.nombre}`).join('\n') || "- Bienestar";
    const equipoTexto = equipoDB?.map(e => `- ${e.nombre} (${e.rol})`).join('\n') || "- Elena";

    // 2. PROCESAMIENTO DE VOZ
    let textoFinal = Body || "";
    if (MediaUrl0) {
      try {
        console.log('🎵 Procesando audio:', MediaUrl0);
        const audioRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 
            'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, // Mejor usar env var
            'Content-Type': 'application/json' 
          }}
        );
        textoFinal = audioRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log('📝 Transcripción:', textoFinal);
      } catch (e) { 
        console.error("Error Deepgram:", e.message); 
      }
    }

    // 3. SYSTEM PROMPT MEJORADO
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

INSTRUCCIÓN CRÍTICA PARA REGISTRO:
Si el usuario confirma o solicita una cita, al final de tu respuesta DEBES incluir EXACTAMENTE este bloque (sin saltos de línea adicionales entre las etiquetas):
DATA_JSON{"servicio": "Nombre exacto del servicio", "fecha": "2024-03-26", "especialista": "Nombre del especialista"}DATA_JSON

Ejemplo real:
DATA_JSON{"servicio": "Masaje Terapéutico", "fecha": "2024-03-28", "especialista": "Elena"}DATA_JSON

Si no hay cita confirmada, NO incluyas el bloque DATA_JSON.`;

    // 4. GENERACIÓN DE RESPUESTA
    console.log('🤖 Enviando a OpenAI...');
    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt }, 
        { role: "user", content: textoFinal }
      ],
      temperature: 0.7
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });

    const fullReply = aiResponse.data.choices[0].message.content;
    console.log('💬 Respuesta completa:', fullReply);
    
    // Extracción más robusta del JSON
    const jsonMatch = fullReply.match(/DATA_JSON\s*([\s\S]*?)\s*DATA_JSON/);
    let cleanReply = fullReply;
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        // Limpiar posibles caracteres problemáticos
        const jsonStr = jsonMatch[1]
          .replace(/[\u201C\u201D]/g, '"') // Comillas tipográficas a rectas
          .replace(/[\u2018\u2019]/g, "'")
          .trim();
          
        console.log('🔧 JSON extraído:', jsonStr);
        const ext = JSON.parse(jsonStr);
        
        // Validar que tenemos datos mínimos
        if (ext.servicio && ext.servicio !== "...") {
          const fechaCita = (ext.fecha && ext.fecha.includes('-')) 
            ? ext.fecha 
            : new Date().toISOString().split('T')[0];

          const airtableData = {
            fields: {
              "Cliente": String(nombreCliente),
              "Servicio": String(ext.servicio),
              "Fecha": fechaCita,
              "Especialista": String(ext.especialista || "Elena"),
              "Teléfono": String(userPhone),
              "Estado": "Pendiente",
              "Notas": `Cita solicitada vía WhatsApp el ${new Date().toLocaleString('es-ES')}`
            }
          };
          
          console.log('📤 Enviando a Airtable:', JSON.stringify(airtableData, null, 2));
          console.log('🔗 URL:', `https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableName}`);

          const airtableRes = await axios.post(
            `https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${encodeURIComponent(AIRTABLE_CONFIG.tableName)}`, 
            airtableData,
            { headers: { 
              'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 
              'Content-Type': 'application/json' 
            }}
          );
          
          console.log('✅ Éxito Airtable:', airtableRes.data.id);
          
          // Limpiar la respuesta para el usuario (quitar el bloque JSON)
          cleanReply = fullReply.replace(/DATA_JSON[\s\S]*?DATA_JSON/, '').trim();
        } else {
          console.log('ℹ️ No hay datos de cita válidos en el JSON');
        }
      } catch (airtableErr) {
        console.error("❌ ERROR AIRTABLE COMPLETO:", {
          message: airtableErr.message,
          status: airtableErr.response?.status,
          statusText: airtableErr.response?.statusText,
          data: airtableErr.response?.data,
          requestData: airtableErr.config?.data
        });
        // Opcional: Notificar al usuario que hubo un problema técnico
        cleanReply = fullReply.replace(/DATA_JSON[\s\S]*?DATA_JSON/, '').trim() + "\n\n(Nota: Tu cita está confirmada, pero estamos teniendo problemas técnicos para registrarla en el sistema. Por favor confirma con nosotros mañana.)";
      }
    } else {
      console.log('⚠️ No se encontró bloque DATA_JSON en la respuesta');
    }

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error("💥 Error General:", error);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send("<Response><Message>Disculpa el inconveniente, estamos ajustando los últimos detalles de la agenda. ¿Podrías repetirme tu solicitud?</Message></Response>");
  }
}
