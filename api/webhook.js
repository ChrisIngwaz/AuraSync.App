import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  console.log(`\n📱 ${userPhone}`);

  try {
    // 1. PROCESAR AUDIO/TEXTO
    let textoUsuario = Body || "";
    
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { 
            headers: { 
              'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 
              'Content-Type': 'application/json' 
            },
            timeout: 15000
          }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log('🎤:', textoUsuario);
      } catch (error) {
        return res.status(200).send('<Response><Message>Error con audio. Escribime por favor.</Message></Response>');
      }
    }

    // 2. CARGAR CLIENTE
    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const { data: historial } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(5);

    const esNuevo = !cliente?.nombre;
    const primerNombre = cliente?.nombre?.split(' ')[0] || null;

    // 3. CATÁLOGO
    const { data: especialistas } = await supabase.from('especialistas').select('nombre');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const listaEsp = especialistas?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "servicios";
    
    const mapaServicios = {};
    servicios?.forEach(s => {
      mapaServicios[s.nombre.toLowerCase()] = s;
      if (s.nombre.toLowerCase().includes('corte')) {
        mapaServicios['cortarme el pelo'] = s;
        mapaServicios['cortar el pelo'] = s;
      }
    });

    // 4. SYSTEM PROMPT - FORZAR JSON AL FINAL
    const systemPrompt = `Eres Aura de AuraSync. ${esNuevo 
      ? 'CLIENTE NUEVO. Pide nombre, apellido y fecha de nacimiento.' 
      : `CLIENTE: ${primerNombre}. Usa solo su nombre.`}

Catálogo: ${catalogo}
Especialistas: ${listaEsp}

INSTRUCCIONES:
- Si pide cita y es nuevo: primero pide datos, luego agenda.
- Convierte fechas naturales a YYYY-MM-DD y HH:MM automáticamente.
- Sé breve y natural.

MUY IMPORTANTE - AL FINAL DE TU RESPUESTA DEBES INCLUIR EXACTAMENTE:
DATA_JSON:{
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "..."
}`;

    // 5. OPENAI
    const messages = [{ role: "system", content: systemPrompt }];
    if (historial) {
      historial.reverse().forEach(msg => messages.push({ role: msg.rol, content: msg.contenido }));
    }
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    console.log('🤖:', fullReply.substring(0, 80));

    // 6. EXTRAER JSON (más flexible)
    let datosExtraidos = {};
    let citaCreada = false;
    
    // Buscar cualquier bloque que parezca JSON
    const jsonMatch = fullReply.match(/DATA_JSON\s*:\s*(\{[\s\S]*?\})(?=\s*$|\s*\n\s*$|:\s*DATA_JSON)/) || 
                      fullReply.match(/DATA_JSON\s*(\{[\s\S]*?\})\s*$/) ||
                      fullReply.match(/\{[\s\S]*?"cita_fecha"[\s\S]*?\}/);
    
    if (jsonMatch) {
      try {
        let jsonStr = jsonMatch[1] || jsonMatch[0];
        jsonStr = jsonStr.replace(/\\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        datosExtraidos = JSON.parse(jsonStr);
        console.log('📋 Datos:', datosExtraidos);

        // Guardar cliente
        if (esNuevo && datosExtraidos.nombre && datosExtraidos.apellido && 
            datosExtraidos.nombre !== "..." && datosExtraidos.apellido !== "...") {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido.trim(),
            fecha_nacimiento: datosExtraidos.fecha_nacimiento !== "..." ? datosExtraidos.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
          console.log('✅ Cliente guardado');
          
          // Actualizar cliente para usar en cita
          cliente = { nombre: datosExtraidos.nombre, apellido: datosExtraidos.apellido };
        }

        // VALIDAR ANTES DE CREAR CITA
        const fechaValida = datosExtraidos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/);
        const horaValida = datosExtraidos.cita_hora?.match(/^\d{2}:\d{2}$/);
        const intencionAgendar = /(quiero|agendar|cita|mañana|hoy|pasado|lunes|martes|miércoles|jueves|viernes|\d{1,2}:\d{2})/.test(textoUsuario.toLowerCase());
        
        if (fechaValida && horaValida && intencionAgendar && cliente?.nombre) {
          const servKey = datosExtraidos.cita_servicio?.toLowerCase();
          const infoServ = mapaServicios[servKey] || { nombre: datosExtraidos.cita_servicio, precio: 0, duracion: 60 };
          
          citaCreada = await crearCitaAirtable({
            telefono: userPhone,
            nombre: cliente.nombre,
            apellido: cliente.apellido || '',
            fecha: datosExtraidos.cita_fecha,
            hora: datosExtraidos.cita_hora,
            servicio: infoServ.nombre,
            especialista: datosExtraidos.cita_especialista || "Cualquiera",
            precio: infoServ.precio,
            duracion: infoServ.duracion
          });
        } else {
          console.log('ℹ️ No se crea cita:', {fechaValida, horaValida, intencionAgendar, tieneNombre: !!cliente?.nombre});
        }
      } catch (e) {
        console.error('❌ Error JSON:', e.message);
      }
    } else {
      console.log('⚠️ No se encontró JSON en la respuesta');
    }

    // Limpiar respuesta
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    if (citaCreada) cleanReply += `\n\n✅ Cita registrada.`;

    // Guardar conversación
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Error técnico. Intenta de nuevo.</Message></Response>');
  }
}

// FUNCIÓN AIRTABLE - SIN CAMPOS PROBLEMÁTICOS
async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    
    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": datos.fecha,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Notas de la cita": "WhatsApp Bot",
          "Email de cliente": "",
          // ELIMINADOS: "Cliente VIP" y "¿Es primera vez?" que dan error 422
          "Duración estimada (minutos)": parseInt(datos.duracion) || 60,
          "Importe estimado": parseFloat(datos.precio) || 0,
          "Observaciones de confirmación": new Date().toLocaleString('es-ES')
        }
      }]
    };

    console.log('📤 Enviando a Airtable:', JSON.stringify(payload, null, 2));
    
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('✅ Cita creada. ID:', response.data.records[0].id);
    return true;
    
  } catch (error) {
    console.error('❌ Error Airtable:', error.response?.status, error.response?.data?.error?.message || error.message);
    return false;
  }
}
