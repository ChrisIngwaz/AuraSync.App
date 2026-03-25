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
    // 1. DIAGNÓSTICO AIRTABLE - Verificar estructura real
    console.log('🔍 Verificando estructura de Airtable...');
    let tableId = null;
    let correctTableName = AIRTABLE_CONFIG.tableName;
    
    try {
      // Listar todas las tablas de la base
      const metaRes = await axios.get(
        `https://api.airtable.com/v0/meta/bases/${AIRTABLE_CONFIG.baseId}/tables`,
        { headers: { 'Authorization': `Bearer ${AIRTABLE_CONFIG.token}` } }
      );
      
      console.log('✅ Tablas disponibles:', metaRes.data.tables.map(t => t.name));
      
      // Buscar tabla exacta (case-insensitive)
      const targetTable = metaRes.data.tables.find(t => 
        t.name.toLowerCase() === AIRTABLE_CONFIG.tableName.toLowerCase()
      );
      
      if (targetTable) {
        correctTableName = targetTable.name; // Usar el nombre exacto como aparece en Airtable
        tableId = targetTable.id;
        console.log('✅ Tabla encontrada:', correctTableName);
        console.log('📋 Campos disponibles:', targetTable.fields.map(f => f.name));
      } else {
        console.error('❌ Tabla "Citas" no encontrada. Tablas existentes:', metaRes.data.tables.map(t => t.name));
        // Fallback: usar primera tabla disponible
        if (metaRes.data.tables.length > 0) {
          correctTableName = metaRes.data.tables[0].name;
          console.log('⚠️ Usando tabla alternativa:', correctTableName);
        }
      }
    } catch (metaErr) {
      console.error('❌ Error al verificar estructura:', metaErr.response?.data || metaErr.message);
    }

    // 2. CONTEXTO Y AUDIO (código anterior)
    const [{ data: historial }, { data: serviciosDB }, { data: equipoDB }, { data: cliente }] = await Promise.all([
      supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: true }).limit(20),
      supabase.from('servicios').select('nombre'),
      supabase.from('especialistas').select('nombre, rol'),
      supabase.from('clientes').select('*').eq('telefono', userPhone).single()
    ]);
    
    const nombreCliente = cliente?.nombre || "amigo/a";
    const catalogoTexto = serviciosDB?.map(s => s.nombre).join(', ') || "Bienestar";
    const equipoTexto = equipoDB?.map(e => `${e.nombre} (${e.rol})`).join(', ') || "Elena";

    let textoUsuario = Body || "";
    if (MediaUrl0) {
      try {
        const audioRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 'Authorization': `Bearer ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }}
        );
        textoUsuario = audioRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (e) { console.error("Error Deepgram:", e.message); }
    }

    // 3. OPENAI CON INSTRUCCIÓN ESTRICTA
    const systemPrompt = `Eres Chris, coordinadora de AuraSync. Hablas con ${nombreCliente}.

REGLA CRÍTICA: Si confirmas una cita, DEBES terminar tu mensaje con:
DATA_JSON{"servicio": "nombre servicio", "fecha": "YYYY-MM-DD", "especialista": "nombre"}DATA_JSON

Servicios: ${catalogoTexto}
Equipo: ${equipoTexto}`;

    const messages = [{ role: "system", content: systemPrompt }];
    if (historial?.length > 0) historial.forEach(msg => messages.push({ role: msg.rol, content: msg.contenido }));
    messages.push({ role: "user", content: textoUsuario || "Hola" });

    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3,
      max_tokens: 200
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });

    const fullReply = aiResponse.data.choices[0].message.content;
    console.log('💬 Respuesta:', fullReply);

    // Guardar conversación
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario },
      { telefono: userPhone, rol: 'assistant', contenido: fullReply }
    ]);

    // 4. EXTRAER JSON Y GUARDAR EN AIRTABLE
    const jsonMatch = fullReply.match(/DATA_JSON\s*(\{.*?\})\s*DATA_JSON/);
    let cleanReply = fullReply.replace(/DATA_JSON\s*\{.*?\}\s*DATA_JSON/, '').trim();
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        const jsonData = JSON.parse(jsonMatch[1].replace(/[\u201C\u201D]/g, '"'));
        console.log('✅ Datos extraídos:', jsonData);

        if (jsonData.servicio && jsonData.servicio !== "...") {
          // INTENTAR CREAR REGISTRO CON MANEJO DE ERRORES DETALLADO
          try {
            // Usar el nombre correcto de tabla descubierto en el diagnóstico
            const url = `https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${encodeURIComponent(correctTableName)}`;
            
            const fields = {
              "Cliente": String(nombreCliente),
              "Servicio": String(jsonData.servicio),
              "Fecha": String(jsonData.fecha || new Date().toISOString().split('T')[0]),
              "Especialista": String(jsonData.especialista || "Elena"),
              "Teléfono": String(userPhone),
              "Estado": "Pendiente"
            };
            
            console.log('📤 POST a:', url);
            console.log('📦 Datos:', JSON.stringify(fields, null, 2));

            const airtableRes = await axios.post(url, { fields }, {
              headers: { 
                'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 
                'Content-Type': 'application/json'
              }
            });
            
            console.log('✅ ÉXITO AIRTABLE:', airtableRes.data.id);
            
          } catch (airtableErr) {
            console.error("❌ ERROR AIRTABLE:", {
              status: airtableErr.response?.status,
              error: airtableErr.response?.data?.error,
              message: airtableErr.message
            });
            
            // SI FALLA POR CAMPO, INTENTAR CON CAMPOS MÍNIMOS
            if (airtableErr.response?.status === 403 || airtableErr.response?.status === 422) {
              console.log('⚠️ Intentando con solo 3 campos básicos...');
              try {
                const minimalRes = await axios.post(
                  `https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${encodeURIComponent(correctTableName)}`,
                  { 
                    fields: {
                      "Cliente": String(nombreCliente),
                      "Servicio": String(jsonData.servicio),
                      "Fecha": String(jsonData.fecha || new Date().toISOString().split('T')[0])
                    }
                  },
                  { headers: { 'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 'Content-Type': 'application/json' }}
                );
                console.log('✅ ÉXITO con campos mínimos:', minimalRes.data.id);
              } catch (err2) {
                console.error("❌ Falló también con campos mínimos:", err2.response?.data || err2.message);
              }
            }
          }
        }
      } catch (e) {
        console.error('❌ Error parseando JSON:', e.message);
      }
    }

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error("💥 Error general:", error);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send("<Response><Message>Disculpa, tuve un problema técnico.</Message></Response>");
  }
}
