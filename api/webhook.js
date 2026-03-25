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
  
  console.log('📞 Webhook:', { userPhone, hasAudio: !!MediaUrl0 });

  try {
    // 1. CARGAR HISTORIAL DE CONVERSACIÓN (últimos 10 mensajes)
    const { data: historial } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: true })
      .limit(10);

    // 2. CONTEXTO DE BASE DE DATOS
    const [{ data: serviciosDB }, { data: equipoDB }, { data: cliente }] = await Promise.all([
      supabase.from('servicios').select('nombre'),
      supabase.from('especialistas').select('nombre, rol'),
      supabase.from('clientes').select('*').eq('telefono', userPhone).single()
    ]);
    
    const nombreCliente = cliente?.nombre || "amigo/a";
    const catalogoTexto = serviciosDB?.map(s => `- ${s.nombre}`).join('\n') || "- Bienestar";
    const equipoTexto = equipoDB?.map(e => `- ${e.nombre} (${e.rol})`).join('\n') || "- Elena";

    // 3. PROCESAR AUDIO
    let textoUsuario = Body || "";
    let tipoEntrada = 'texto';
    
    if (MediaUrl0) {
      try {
        console.log('🎵 Procesando audio...');
        const audioRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true", 
          { url: MediaUrl0 }, 
          { headers: { 
            'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 
            'Content-Type': 'application/json' 
          }}
        );
        textoUsuario = audioRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        tipoEntrada = 'audio';
        console.log('📝 Transcripción:', textoUsuario);
      } catch (e) { 
        console.error("Error Deepgram:", e.message); 
      }
    }

    if (!textoUsuario.trim()) {
      textoUsuario = "No se pudo transcribir el audio";
    }

    // 4. CONSTRUIR MENSAJES PARA OPENAI (CON MEMORIA)
    const systemPrompt = `Eres Chris, la Coordinadora de AuraSync. Estás en medio de una conversación continua con ${nombreCliente}.

CONTEXTO DEL NEGOCIO:
- Servicios disponibles: ${catalogoTexto}
- Equipo: ${equipoTexto}

REGLAS CRÍTICAS:
1. NUNCA digas que eres IA. Eres Chris, la coordinadora humana.
2. MANTÉN EL CONTEXTO: Revisa el historial de conversación. Si ya ofreciste una cita y el usuario confirma (dice "sí", "ok", "perfecto", "confirmo", etc), CONFIRMA esa misma cita, no preguntes de nuevo.
3. Si el usuario confirma una cita propuesta anteriormente, usa los datos de esa propuesta (servicio, fecha, especialista) para generar el JSON.
4. Si el usuario quiere cambiar algo, aclara amablemente.
5. BREVEDAD: Máximo 2 oraciones, lenguaje cálido y humano.

FORMATO DE RESPUESTA:
- Si se confirma cita: responde normalmente y al final incluye: DATA_JSON{"servicio": "...", "fecha": "YYYY-MM-DD", "especialista": "..."}DATA_JSON
- Si no hay cita confirmada: NO incluyas el bloque DATA_JSON`;

    const messages = [
      { role: "system", content: systemPrompt }
    ];

    // Agregar historial previo
    if (historial && historial.length > 0) {
      historial.forEach(msg => {
        messages.push({ role: msg.rol, content: msg.contenido });
      });
    }

    // Agregar mensaje actual del usuario
    messages.push({ role: "user", content: textoUsuario });

    console.log('🤖 Enviando a OpenAI:', messages.length, 'mensajes');

    // 5. LLAMADA A OPENAI
    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.7,
      max_tokens: 300
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });

    const fullReply = aiResponse.data.choices[0].message.content;
    console.log('💬 Respuesta:', fullReply);

    // 6. GUARDAR EN HISTORIAL (usuario y asistente)
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, tipo: tipoEntrada },
      { telefono: userPhone, rol: 'assistant', contenido: fullReply, tipo: 'texto' }
    ]);

    // 7. EXTRAER JSON Y REGISTRAR EN AIRTABLE
    const jsonMatch = fullReply.match(/DATA_JSON\s*([\s\S]*?)\s*DATA_JSON/);
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*?DATA_JSON/, '').trim();
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        const jsonStr = jsonMatch[1]
          .replace(/[\u201C\u201D]/g, '"')
          .replace(/[\u2018\u2019]/g, "'")
          .trim();
          
        const ext = JSON.parse(jsonStr);
        console.log('🔧 Datos cita:', ext);

        if (ext.servicio && ext.servicio !== "...") {
          // Verificar si ya existe una cita idéntica pendiente (evitar duplicados)
          const { data: existente } = await supabase
            .from('conversaciones')
            .select('*')
            .eq('telefono', userPhone)
            .ilike('contenido', `%${ext.servicio}%`)
            .gte('created_at', new Date(Date.now() - 5*60000).toISOString()) // últimos 5 min
            .limit(1);

          if (!existente || existente.length === 0) {
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
                "Notas": `Confirmado vía WhatsApp el ${new Date().toLocaleString('es-ES')}`
              }
            };

            console.log('📤 Guardando en Airtable:', airtableData);
            
            await axios.post(
              `https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${encodeURIComponent(AIRTABLE_CONFIG.tableName)}`, 
              airtableData,
              { headers: { 
                'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 
                'Content-Type': 'application/json' 
              }}
            );
            
            console.log('✅ Cita registrada');
          } else {
            console.log('⚠️ Cita ya registrada recientemente');
          }
        }
      } catch (err) {
        console.error("❌ Error procesando cita:", err.message);
        // No fallar la respuesta al usuario por error de backend
      }
    }

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error("💥 Error:", error);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send("<Response><Message>Disculpa, tuve un pequeño problema técnico. ¿Podemos continuar?</Message></Response>");
  }
}
