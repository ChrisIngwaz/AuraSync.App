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
  
  console.log('📞 === NUEVA PETICIÓN ===');
  console.log('Teléfono:', userPhone);
  console.log('Body:', Body);
  console.log('MediaUrl0:', MediaUrl0 ? 'Sí' : 'No');

  try {
    // 1. VERIFICAR/CARGAR HISTORIAL CON DEBUG
    let historial = [];
    try {
      const { data, error } = await supabase
        .from('conversaciones')
        .select('rol, contenido')
        .eq('telefono', userPhone)
        .order('created_at', { ascending: true })
        .limit(10);
        
      if (error) {
        console.error('❌ Error cargando historial:', error.message);
        // Si la tabla no existe, intentar crearla silenciosamente o continuar sin historial
        if (error.message.includes('does not exist') || error.code === '42P01') {
          console.log('⚠️ Tabla conversaciones no existe. Creando...');
          // Crear tabla si no existe
          await supabase.rpc('crear_tabla_conversaciones').catch(() => {
            console.log('No se pudo crear tabla automáticamente');
          });
        }
      } else {
        historial = data || [];
        console.log('📚 Historial cargado:', historial.length, 'mensajes');
        if (historial.length > 0) {
          console.log('Último mensaje:', historial[historial.length-1].contenido.substring(0, 50));
        }
      }
    } catch (histError) {
      console.error('❌ Error crítico en historial:', histError.message);
    }

    // 2. CONTEXTO DB
    const [{ data: serviciosDB }, { data: equipoDB }, { data: cliente }] = await Promise.all([
      supabase.from('servicios').select('nombre'),
      supabase.from('especialistas').select('nombre, rol'),
      supabase.from('clientes').select('*').eq('telefono', userPhone).single()
    ]);
    
    const nombreCliente = cliente?.nombre || "amigo/a";
    const catalogoTexto = serviciosDB?.map(s => `- ${s.nombre}`).join('\n') || "- Bienestar";
    const equipoTexto = equipoDB?.map(e => `- ${e.nombre} (${e.rol})`).join('\n') || "- Elena";

    // 3. PROCESAR AUDIO/TEXTO
    let textoUsuario = Body || "";
    let tipoEntrada = 'texto';
    
    if (MediaUrl0) {
      try {
        const audioRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 
            'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 
            'Content-Type': 'application/json' 
          }}
        );
        textoUsuario = audioRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        tipoEntrada = 'audio';
        console.log('🎵 Audio transcrito:', textoUsuario);
      } catch (e) { 
        console.error("Error Deepgram:", e.message); 
      }
    }

    if (!textoUsuario.trim()) textoUsuario = "Mensaje vacío";

    // 4. CONSTRUIR MENSAJES CON HISTORIAL
    const systemPrompt = `Eres Chris, coordinadora de AuraSync. Estás conversando con ${nombreCliente}.

CONTEXTO ACTUAL:
${historial.length === 0 ? 'Esta es la primera interacción.' : `Ya has conversado ${historial.length} mensajes con este cliente.`}

REGLAS ABSOLUTAS:
1. Eres humana, nunca digas que eres IA.
2. REVISA EL HISTORIAL ANTERIOR. Si ya propusiste una cita específica (servicio, fecha, especialista) y el usuario responde con "sí", "ok", "perfecto", "confirmo", "dale", CONFIRMA ESA CITA específica.
3. Si no hay historial o contexto previo, entonces pregunta normalmente.
4. Máximo 2 oraciones, tono cálido.

CATÁLOGO: ${catalogoTexto}
EQUIPO: ${equipoTexto}

FORMATO: Si confirmas cita, termina con: DATA_JSON{"servicio": "...", "fecha": "YYYY-MM-DD", "especialista": "..."}DATA_JSON`;

    const messages = [{ role: "system", content: systemPrompt }];
    
    // Agregar historial previo si existe
    historial.forEach(msg => {
      messages.push({ role: msg.rol, content: msg.contenido });
    });

    // Agregar mensaje actual
    messages.push({ role: "user", content: textoUsuario });
    
    console.log('🤖 Enviando a OpenAI', messages.length, 'mensajes...');

    // 5. LLAMADA OPENAI
    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.7,
      max_tokens: 250
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });

    const fullReply = aiResponse.data.choices[0].message.content;
    console.log('💬 Respuesta IA:', fullReply.substring(0, 100));

    // 6. GUARDAR INTERACCIÓN (con manejo de errores)
    try {
      const { error: insertError } = await supabase.from('conversaciones').insert([
        { telefono: userPhone, rol: 'user', contenido: textoUsuario, tipo: tipoEntrada },
        { telefono: userPhone, rol: 'assistant', contenido: fullReply, tipo: 'texto' }
      ]);
      
      if (insertError) {
        console.error('❌ Error guardando conversación:', insertError.message);
      } else {
        console.log('✅ Conversación guardada en Supabase');
      }
    } catch (saveError) {
      console.error('❌ Error crítico guardando:', saveError.message);
    }

    // 7. PROCESAR JSON Y AIRTABLE
    const jsonMatch = fullReply.match(/DATA_JSON\s*([\s\S]*?)\s*DATA_JSON/);
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*?DATA_JSON/, '').trim();
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        const jsonStr = jsonMatch[1].replace(/[\u201C\u201D]/g, '"').trim();
        const ext = JSON.parse(jsonStr);
        console.log('🔧 Extrayendo cita:', ext);

        if (ext.servicio && ext.servicio !== "...") {
          const fechaCita = (ext.fecha && ext.fecha.includes('-')) 
            ? ext.fecha 
            : new Date().toISOString().split('T')[0];

          console.log('📤 Registrando en Airtable...');
          
          await axios.post(
            `https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${encodeURIComponent(AIRTABLE_CONFIG.tableName)}`, 
            { fields: {
              "Cliente": String(nombreCliente),
              "Servicio": String(ext.servicio),
              "Fecha": fechaCita,
              "Especialista": String(ext.especialista || "Elena"),
              "Teléfono": String(userPhone),
              "Estado": "Pendiente",
              "Notas": `Confirmado: ${new Date().toLocaleString('es-ES')}`
            }},
            { headers: { 'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 'Content-Type': 'application/json' }}
          );
          
          console.log('✅ Cita guardada en Airtable');
        }
      } catch (err) {
        console.error("❌ Error Airtable:", err.response?.data || err.message);
      }
    } else {
      console.log('⚠️ No se encontró DATA_JSON en respuesta');
    }

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error("💥 Error general:", error);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send("<Response><Message>Disculpa, tuve un problema técnico. ¿Podemos intentar de nuevo?</Message></Response>");
  }
}
