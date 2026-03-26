import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const AIRTABLE_CONFIG = {
  token: (process.env.AIRTABLE_TOKEN || '').trim(), 
  baseId: 'appvuzv3szWik7kn7',
  tableName: 'Citas'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(405).send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Método no permitido</Message></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');
  
  console.log('📞 Petición:', { userPhone, hasMedia: !!MediaUrl0 });

  try {
    // 1. PROCESAR AUDIO
    let textoUsuario = Body || "";
    
    if (MediaUrl0) {
      try {
        if (!process.env.DEEPGRAM_API_KEY) {
          console.error('❌ DEEPGRAM_API_KEY no configurada');
          textoUsuario = "Audio recibido pero no pudo procesarse";
        } else {
          console.log('🎵 Procesando audio...');
          const audioRes = await axios.post(
            "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
            { url: MediaUrl0 }, 
            { 
              headers: { 
                'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 
                'Content-Type': 'application/json' 
              },
              timeout: 10000
            }
          );
          
          textoUsuario = audioRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "No se pudo transcribir";
          console.log('✅ Audio:', textoUsuario);
        }
      } catch (audioErr) {
        console.error('❌ Deepgram:', audioErr.response?.status, audioErr.message);
        textoUsuario = Body || "No pude entender el audio, ¿podrías escribirlo?";
      }
    }

    // 2. CARGAR DATOS DE SUPABASE
    const [histRes, servRes, eqRes, cliRes] = await Promise.all([
      supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: true }).limit(10),
      supabase.from('servicios').select('nombre'),
      supabase.from('especialistas').select('nombre, rol'),
      supabase.from('clientes').select('*').eq('telefono', userPhone).single()
    ]);
    
    const historial = histRes.data || [];
    const serviciosDB = servRes.data || [];
    const equipoDB = eqRes.data || [];
    const cliente = cliRes.data;
    
    const nombreCliente = cliente?.nombre || "amigo/a";
    const catalogoTexto = serviciosDB.map(s => s.nombre).join(', ') || "Manicura, Pedicure, Corte, Peinado";
    const equipoTexto = equipoDB.map(e => `${e.nombre} (${e.rol})`).join(', ') || "Elena";

    // 3. OPENAI
    const systemPrompt = `Eres Chris, coordinadora de AuraSync. Cliente: ${nombreCliente}.

Servicios: ${catalogoTexto}
Especialistas: ${equipoTexto}

REGLAS:
1. Eres humana, NO IA
2. Si confirmas cita, incluye: DATA_JSON{"servicio": "...", "fecha": "YYYY-MM-DD", "especialista": "..."}DATA_JSON
3. Mantén contexto: si ya propusiste cita y usuario dice "sí", confirma esa misma cita`;

    const messages = [{ role: "system", content: systemPrompt }];
    historial.slice(-6).forEach(msg => messages.push({ role: msg.rol, content: msg.contenido }));
    messages.push({ role: "user", content: textoUsuario });

    console.log('🤖 OpenAI...');
    const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.7,
      max_tokens: 250
    }, { 
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 15000
    });
    
    const fullReply = aiResponse.data.choices[0].message.content;
    console.log('💬 Respuesta:', fullReply.substring(0, 100));

    // 4. GUARDAR CONVERSACIÓN
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, tipo: MediaUrl0 ? 'audio' : 'texto' },
      { telefono: userPhone, rol: 'assistant', contenido: fullReply, tipo: 'texto' }
    ]);

    // 5. EXTRAER JSON Y GUARDAR EN AIRTABLE
    const jsonMatch = fullReply.match(/DATA_JSON\s*(\{.*?\})\s*DATA_JSON/);
    let cleanReply = fullReply.replace(/DATA_JSON\s*\{.*?\}\s*DATA_JSON/, '').trim();
    
    if (jsonMatch) {
      try {
        const jsonData = JSON.parse(jsonMatch[1].replace(/[\u201C\u201D]/g, '"'));
        console.log('✅ JSON:', jsonData);
        
        if (jsonData.servicio && jsonData.servicio !== "...") {
          const fields = {
            "Cliente": String(nombreCliente),
            "Servicio": String(jsonData.servicio),
            "Fecha": String(jsonData.fecha || new Date().toISOString().split('T')[0]),
            "Especialista": String(jsonData.especialista || "Elena"),
            "Teléfono": String(userPhone),
            "Estado": "Pendiente"
          };
          
          console.log('📤 Airtable:', fields);
          
          try {
            const airtableRes = await axios.post(
              `https://api.airtable.com/v0/${AIRTABLE_CONFIG.baseId}/${encodeURIComponent(AIRTABLE_CONFIG.tableName)}`,
              { fields },
              { 
                headers: { 'Authorization': `Bearer ${AIRTABLE_CONFIG.token}`, 'Content-Type': 'application/json' },
                timeout: 10000
              }
            );
            console.log('✅ Cita guardada:', airtableRes.data.id);
          } catch (airErr) {
            console.error('❌ Airtable:', airErr.response?.status, airErr.response?.data || airErr.message);
            // Guardar en Supabase como backup
            await supabase.from('citas_backup').insert({
              telefono: userPhone,
              cliente: nombreCliente,
              servicio: jsonData.servicio,
              fecha: jsonData.fecha,
              especialista: jsonData.especialista,
              estado: 'Pendiente'
            });
          }
        }
      } catch (e) {
        console.error('❌ Error JSON:', e.message);
      }
    }

    // 6. RESPONDER
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error('💥 Error:', error.message);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response><Message>Disculpa, tuve un problema técnico. Intenta de nuevo.</Message></Response>');
  }
}
