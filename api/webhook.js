import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const AIRTABLE_BASE = 'appvuzv3szWik7kn7';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<?xml version="1.0"?><Response><Message>Error</Message></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '');
  
  console.log('📞 === NUEVA SESIÓN ===', userPhone);

  try {
    // 1. PROCESAR AUDIO
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      try {
        const audioRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { headers: { 'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' }}
        );
        textoUsuario = audioRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (e) { 
        textoUsuario = "No entendí el audio"; 
      }
    }

    // 2. CARGAR DATOS Y HISTORIAL
    const [histRes, servRes, eqRes, cliRes] = await Promise.all([
      supabase.from('conversaciones').select('rol, contenido, created_at').eq('telefono', userPhone).order('created_at', { ascending: true }).limit(20),
      supabase.from('servicios').select('nombre'),
      supabase.from('especialistas').select('nombre, rol'),
      supabase.from('clientes').select('*').eq('telefono', userPhone).single()
    ]);
    
    const historial = histRes.data || [];
    const serviciosDB = servRes.data || [];
    const equipoDB = eqRes.data || [];
    const cliente = cliRes.data;
    const nombreCliente = cliente?.nombre || "amigo/a";

    // 3. EXTRAER ÚLTIMA PROPUESTA DEL HISTORIAL (REGEX ROBUSTO)
    let propuestaAnterior = null;
    if (historial.length > 0) {
      // Buscar en mensajes del asistente (últimos 3)
      const mensajesAsistente = historial.filter(h => h.rol === 'assistant').slice(-3);
      
      for (const msg of mensajesAsistente.reverse()) {
        // Buscar patrón: "Especialista está disponible para Servicio a las Hora"
        // o "Para FECHA a las HORA, ESPECIALISTA está disponible para SERVICIO"
        const match = msg.contenido.match(/Para\s+(mañana|hoy|el\s+\w+|[^\s,]+)\s+(?:a\s+las?|a\s+la)\s+(\d+(?::\d+)?\s*(?:de\s+la\s+tarde|de\s+la\s+mañana|am|pm)?)\s*,?\s*(\w+)\s+está\s+disponible\s+para\s+(?:un\s+|una\s+)?([^.¿!]+)/i);
        
        if (match) {
          propuestaAnterior = {
            fechaTexto: match[1], // "mañana"
            hora: match[2].trim(), // "5 de la tarde"
            especialista: match[3].trim(), // "Carlos"
            servicio: match[4].trim() // "corte de cabello"
          };
          console.log('✅ Propuesta encontrada:', propuestaAnterior);
          break;
        }
      }
    }

    // 4. DETECTAR SI ES CONFIRMACIÓN
    const esConfirmacion = /(?:sí|si|ok|vale|dale|confirmo|perfecto|genial|de\s+acuerdo|está\s+bien|me\s+parece\s+bien)/i.test(textoUsuario);
    
    console.log('🔍 Usuario dice:', textoUsuario);
    console.log('🔍 ¿Es confirmación?:', esConfirmacion);
    console.log('🔍 Propuesta previa:', propuestaAnterior);

    // 5. CONSTRUIR PROMPT CON CONTEXTO EXPLÍCITO
    let systemPrompt = `Eres Chris, coordinadora de AuraSync. Cliente: ${nombreCliente}.
INSTRUCCIÓN CRÍTICA: `;

    if (esConfirmacion && propuestaAnterior) {
      // FORZAR USO DE DATOS EXTRAÍDOS
      systemPrompt += `El usuario está CONFIRMANDO la cita propuesta anteriormente. 
DATOS EXACTOS A USAR:
- Especialista: ${propuestaAnterior.especialista}
- Servicio: ${propuestaAnterior.servicio}
- Cuándo: ${propuestaAnterior.fechaTexto} a las ${propuestaAnterior.hora}

Responde confirmando con estos datos EXACTOS. Luego agrega obligatoriamente:
DATA_JSON{"servicio": "${propuestaAnterior.servicio}", "fecha": "FECHA_ISO", "especialista": "${propuestaAnterior.especialista}"}DATA_JSON

Calcula FECHA_ISO: si dice "mañana" usa ${getFechaManana()}, si dice "hoy" usa ${new Date().toISOString().split('T')[0]}`;
    } else {
      // NUEVA CITA O CONSULTA
      systemPrompt += `Servicios: ${serviciosDB.map(s => s.nombre).join(', ')}.
Especialistas: ${equipoDB.map(e => e.nombre).join(', ')}.
Si propones cita, usa formato: "Para [fecha] a las [hora], [especialista] está disponible para [servicio]".
Si confirman, agrega DATA_JSON{"servicio": "...", "fecha": "YYYY-MM-DD", "especialista": "..."}DATA_JSON`;
    }

    // 6. LLAMADA A OPENAI
    const messages = [{ role: "system", content: systemPrompt }];
    historial.slice(-5).forEach(h => messages.push({ role: h.rol, content: h.contenido }));
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.1, // BAJO para obedecer instrucciones al pie de la letra
      max_tokens: 200
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    console.log('💬 Respuesta IA:', fullReply);

    // 7. VALIDACIÓN FINAL ANTES DE GUARDAR
    let jsonData = null;
    const jsonMatch = fullReply.match(/DATA_JSON\s*(\{.*?\})\s*DATA_JSON/);
    
    if (jsonMatch) {
      try {
        jsonData = JSON.parse(jsonMatch[1].replace(/[\u201C\u201D]/g, '"'));
        
        // VALIDAR CONTRA PROPUESTA ANTERIOR SI ES CONFIRMACIÓN
        if (esConfirmacion && propuestaAnterior) {
          const servicioCorrecto = propuestaAnterior.servicio.toLowerCase().includes(jsonData.servicio.toLowerCase()) || 
                                  jsonData.servicio.toLowerCase().includes(propuestaAnterior.servicio.toLowerCase());
          const especialistaCorrecto = jsonData.especialista === propuestaAnterior.especialista;
          
          if (!servicioCorrecto || !especialistaCorrecto) {
            console.error('❌ IA CAMBIÓ LOS DATOS. Forzando corrección...');
            // Corregir automáticamente
            jsonData.servicio = propuestaAnterior.servicio;
            jsonData.especialista = propuestaAnterior.especialista;
            jsonData.fecha = calcularFechaISO(propuestaAnterior.fechaTexto);
            
            // Reconstruir respuesta limpia
            fullReply = `¡Perfecto! Tu cita para ${jsonData.servicio} con ${jsonData.especialista} está confirmada para ${propuestaAnterior.fechaTexto} a las ${propuestaAnterior.hora}. DATA_JSON${JSON.stringify(jsonData)}DATA_JSON`;
          }
        }
        
        console.log('✅ JSON validado:', jsonData);
      } catch (e) {
        console.error('❌ Error parseando JSON:', e);
      }
    }

    // 8. GUARDAR CONVERSACIÓN
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario },
      { telefono: userPhone, rol: 'assistant', contenido: fullReply }
    ]);

    // 9. GUARDAR EN AIRTABLE
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*?DATA_JSON/, '').trim();
    
    if (jsonData && jsonData.servicio) {
      try {
        const fields = {
          "Cliente": nombreCliente,
          "Servicio": jsonData.servicio,
          "Fecha": jsonData.fecha || new Date().toISOString().split('T')[0],
          "Especialista": jsonData.especialista,
          "Teléfono": userPhone,
          "Estado": "Pendiente"
        };
        
        await axios.post(
          `https://api.airtable.com/v0/${AIRTABLE_BASE}/Citas`,
          { fields },
          { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }}
        );
        console.log('✅ Guardado en Airtable:', fields);
      } catch (airErr) {
        console.error('❌ Airtable:', airErr.response?.data || airErr.message);
        cleanReply += "\n\n(Nota: Confirma tu cita por teléfono)";
      }
    }

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<?xml version="1.0"?><Response><Message>${cleanReply}</Message></Response>`);

  } catch (error) {
    console.error('💥 Error:', error);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<?xml version="1.0"?><Response><Message>Disculpa, hubo un error técnico.</Message></Response>');
  }
}

// Helper para calcular fechas
function getFechaManana() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function calcularFechaISO(textoFecha) {
  const hoy = new Date();
  if (textoFecha.toLowerCase().includes('mañana')) {
    hoy.setDate(hoy.getDate() + 1);
  }
  return hoy.toISOString().split('T')[0];
}
