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
    const systemPrompt = `Eres Aura de AuraSync, "El 1er mentor 24/7 en el mundo para el bienestar", "El Guardián de la Coherencia del cuerpo humano".
    
    CONTEXTO DEL CLIENTE ACTUAL:
    - Nombre: ${cliente?.nombre || 'Desconocido'}
    - Apellido: ${cliente?.apellido || 'Desconocido'}
    - ¿Está registrado?: ${esNuevo ? 'NO. DEBES PEDIR NOMBRE, APELLIDO Y FECHA DE NACIMIENTO.' : 'SÍ. YA TIENES SUS DATOS, NO LOS PIDAS DE NUEVO.'}

    REGLA CRÍTICA: 
    Si el nombre es "${primerNombre}", ya lo conoces. Salúdalo por su nombre y pasa directamente a agendar o asesorar. No seas repetitivo.

    INSTRUCCIÓN TÉCNICA OBLIGATORIA: 
    Al final de cada respuesta, sin excepción, añade el bloque JSON con los datos. Si ya tienes el nombre, rellénalo en el JSON.
    
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

    // 6. EXTRAER JSON (Súper Reforzado)
    let datosExtraidos = {};
    let citaCreada = false;
    
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        const jsonStr = jsonMatch[1].trim();
        datosExtraidos = JSON.parse(jsonStr);
        console.log('📋 Datos detectados:', datosExtraidos);

        // --- CAMBIO AQUÍ: ACTUALIZACIÓN INMEDIATA ---
        if (datosExtraidos.nombre && datosExtraidos.nombre !== "...") {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: (datosExtraidos.apellido && datosExtraidos.apellido !== "...") ? datosExtraidos.apellido.trim() : "",
            fecha_nacimiento: (datosExtraidos.fecha_nacimiento && datosExtraidos.fecha_nacimiento !== "...") ? datosExtraidos.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
          
          console.log('✅ Cliente actualizado en Supabase');
          
          // Llenamos la variable cliente manualmente para que la cita no salga vacía
          if (!cliente) cliente = {};
          cliente.nombre = datosExtraidos.nombre;
          cliente.apellido = datosExtraidos.apellido !== "..." ? datosExtraidos.apellido : "";
        }

        // LÓGICA DE CITA
        const tieneFecha = datosExtraidos.cita_fecha && datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/);
        const tieneHora = datosExtraidos.cita_hora && datosExtraidos.cita_hora.match(/^\d{2}:\d{2}$/);
        
        if (tieneFecha && tieneHora && cliente?.nombre) {
          citaCreada = await crearCitaAirtable({
            telefono: userPhone,
            nombre: cliente.nombre,
            apellido: cliente.apellido || '',
            fecha: datosExtraidos.cita_fecha,
            hora: datosExtraidos.cita_hora,
            servicio: datosExtraidos.cita_servicio !== "..." ? datosExtraidos.cita_servicio : "Corte de Cabello Premium",
            especialista: datosExtraidos.cita_especialista !== "..." ? datosExtraidos.cita_especialista : "Cualquiera",
            precio: mapaServicios[datosExtraidos.cita_servicio?.toLowerCase()]?.precio || 0, 
            duracion: mapaServicios[datosExtraidos.cita_servicio?.toLowerCase()]?.duracion || 60
          });
        }
      } catch (e) {
        console.error('❌ Error parseando JSON:', e.message);
      }
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
    
    // Mapeo EXACTO a tus columnas de Airtable
    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio || "Corte de Cabello Premium",
          "Fecha": datos.fecha, // Debe ser YYYY-MM-DD
          "Especialista": datos.especialista || "Cualquiera",
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Notas de la cita": "Agendado por AuraSync",
          "Email de cliente": datos.email || "",
          "Duración estimada (minutos)": parseInt(datos.duracion) || 60,
          "Importe estimado": parseFloat(datos.precio) || 0,
          "Observaciones de confirmación": `Confirmado el ${new Date().toLocaleString('es-ES')}`
        }
      }]
    };

    console.log('📤 Enviando a Airtable...');
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('✅ Cita en Airtable ID:', response.data.records[0].id);
    return true;
    
  } catch (error) {
    // Esto te dirá exactamente qué columna está mal en los logs de Vercel
    console.error('❌ ERROR AIRTABLE:', error.response?.data?.error || error.message);
    return false;
  }
}
