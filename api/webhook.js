const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const AIRTABLE_CONFIG = {
  token: (process.env.AIRTABLE_TOKEN || '').trim(), 
  baseId: 'appvuzv3szWik7kn7',
  tableName: 'Citas'  // Verifica que este nombre sea EXACTO (distingue mayúsculas)
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');
  
  console.log('📞 === NUEVA PETICIÓN ===');
  console.log('Teléfono:', userPhone);

  try {
    // 1. CARGAR CONTEXTO
    const [{ data: historial }, { data: serviciosDB }, { data: equipoDB }, { data: cliente }] = await Promise.all([
      supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: true }).limit(20),
      supabase.from('servicios').select('nombre'),
      supabase.from('especialistas').select('nombre, rol'),
      supabase.from('clientes').select('*').eq('telefono', userPhone).single()
    ]);
    
    const nombreCliente = cliente?.nombre || "amigo/a";
    const catalogoTexto = serviciosDB?.map(s => s.nombre).join(', ') || "Bienestar";
    const equipoTexto = equipoDB?.map(e => `${e.nombre} (${e.rol})`).join(', ') || "Elena";

    // 2. PROCESAR AUDIO
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      try {
        const audioRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }}
        );
        textoUsuario = audioRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log('🎵 Audio:', textoUsuario);
      } catch (e) { console.error("Error Deepgram:", e.message); }
    }

    if (!textoUsuario.trim()) textoUsuario = "Hola";

    // 3. PROMPT MEJORADO Y EXPLÍCITO
    const systemPrompt = `Eres Chris, coordinadora humana de AuraSync. Hablas con ${nombreCliente}.

REGLAS ABSOLUTAS (VIOLARLAS ES CRÍTICO):
1. NUNCA digas que eres IA. Eres la coordinadora humana del centro.
2. Si CONFIRMAS una cita explícitamente (dices "está confirmada", "queda agendada", "perfecto, te esperamos"), DEBES incluir OBLIGATORIAMENTE al final:
DATA_JSON{"servicio": "nombre exacto del servicio", "fecha": "YYYY-MM-DD", "especialista": "nombre del especialista"}DATA_JSON

3. Si solo estás preguntando/proponiendo, NO incluyas DATA_JSON.

Servicios disponibles: ${catalogoTexto}
Especialistas: ${equipoTexto}
Fecha de hoy: ${new Date().toISOString().split('T')[0]}

Historial reciente: ${historial?.length > 0 ? 'Ya conversaron sobre citas anteriormente' : 'Primera interacción'}

INSTRUCCIÓN FINAL: Si el usuario confirma una cita que propusiste, responde confirmando e incluye SIEMPRE el bloque DATA_JSON al final.`;

    const messages = [{ role: "system", content: systemPrompt }];
    if (historial?.length > 0) {
      historial.forEach(msg => messages.push({ role: msg.rol, content: msg.contenido }));
    }
    messages.push({ role: "user", content: textoUsuario });

    console.log('🤖 OpenAI con', messages.length, 'mensajes');

    // 4. LLAMADA A OPENAI
    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3,  // Más determinístico para obedecer instrucciones
      max_tokens: 200
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });

    const fullReply = aiResponse.data.choices[0].message.content;
    console.log('💬 Respuesta:', fullReply);

    // 5. GUARDAR CONVERSACIÓN
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario },
      { telefono: userPhone, rol: 'assistant', contenido: fullReply }
    ]);

    // 6. EXTRACCIÓN ROBUSTA DE JSON
    let jsonData = null;
    let cleanReply = fullReply;
    
    // Buscar patrón DATA_JSON
    const jsonMatch = fullReply.match(/DATA_JSON\s*(\{.*?\})\s*DATA_JSON/);
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        const jsonStr = jsonMatch[1].replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
        jsonData = JSON.parse(jsonStr);
        console.log('✅ JSON extraído:', jsonData);
        cleanReply = fullReply.replace(/DATA_JSON\s*\{.*?\}\s*DATA_JSON/, '').trim();
      } catch (e) {
        console.error('❌ Error parseando JSON:', e.message, jsonMatch[1]);
      }
    } else {
      console.log('⚠️ No se encontró DATA_JSON');
      
      // Plan B: Si la respuesta contiene palabras de confirmación pero no hay JSON,
      // intentar extraer info del contexto anterior (último mensaje del asistente)
      const confirmWords = ['confirmada', 'agendada', 'reservada', 'queda', 'perfecto', 'genial'];
      const isConfirming = confirmWords.some(word => fullReply.toLowerCase().includes(word));
      
      if (isConfirming && historial?.length > 0) {
        // Buscar en el historial anterior si el bot propuso una cita
        const lastAssistantMsg = [...historial].reverse().find(m => m.rol === 'assistant');
        if (lastAssistantMsg) {
          console.log('🔍 Intentando extraer de contexto previo:', lastAssistantMsg.contenido);
          // Aquí podrías parsear el mensaje anterior para extraer servicio/fecha/especialista
          // y generar jsonData manualmente
        }
      }
    }

    // 7. REGISTRO EN AIRTABLE (con validación de datos)
    if (jsonData && jsonData.servicio && jsonData.servicio !== "...") {
      try {
        // Validar que tenemos todos los campos
        if (!jsonData.fecha || jsonData.fecha === "YYYY-MM-DD") {
          jsonData.fecha = new Date().toISOString().split('T')[0]; // Hoy por defecto
        }
        
        const airtablePayload = {
          fields: {
            "Cliente": String(nombreCliente),
            "Servicio": String(jsonData.servicio),
            "Fecha": String(jsonData.fecha),
            "Especialista": String(jsonData.especialista || "Elena"),
            "Teléfono": String(userPhone),
            "Estado": "Pendiente"
          }
        };
        
        console.log('📤 Enviando a Airtable:', JSON.stringify(airtablePayload));
        console.log('🔗 URL:', `https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${AIRTABLE_CONFIG.tableName}`);
        console.log('🔑 Token (primeros 10):', AIRTABLE_CONFIG.token.substring(0, 10) + '...');

        const airtableRes = await axios.post(
          `https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${encodeURIComponent(AIRTABLE_CONFIG.tableName)}`,
          airtablePayload,
          { headers: { 
            'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 
            'Content-Type': 'application/json'
          }}
        );
        
        console.log('✅ Éxito Airtable:', airtableRes.data.id);
        
        // Guardar confirmación en Supabase también (backup)
        await supabase.from('citas_confirmadas').insert({
          telefono: userPhone,
          servicio: jsonData.servicio,
          fecha: jsonData.fecha,
          especialista: jsonData.especialista,
          airtable_id: airtableRes.data.id
        });

      } catch (airtableErr) {
        console.error("❌ ERROR AIRTABLE DETALLADO:", {
          message: airtableErr.message,
          status: airtableErr.response?.status,
          data: airtableErr.response?.data,
          errorType: airtableErr.response?.data?.error?.type
        });
        
        // Notificar en la respuesta que hubo error técnico pero la cita está "confirmada" localmente
        cleanReply += "\n\n(Nota: Tu cita está anotada, pero por favor confirma también por teléfono mañana)";
      }
    } else {
      console.log('ℹ️ No hay datos de cita para guardar');
    }

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error("💥 Error general:", error);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send("<Response><Message>Disculpa, tuve un problema técnico. ¿Podemos intentar de nuevo?</Message></Response>");
  }
}
