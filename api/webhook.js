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

    // 4. SYSTEM PROMPT - DEFINICIÓN DE AURA (Reforzada)
    const infoAura = 'Eres Aura, la Asistente Inteligente de AuraSync. Tu único objetivo es gestionar citas y registrar clientes de forma profesional. 

    const systemPrompt = `${infoAura}
    
    [INSTRUCCIÓN CRÍTICA DE IDENTIDAD]
    - Tu nombre es Aura.
    - El cliente actual es: ${esNuevo ? 'TOTALMENTE DESCONOCIDO. Es su primera vez.' : primerNombre}.
    - ${esNuevo 
      ? 'Como es desconocido, tu saludo debe ser frío pero cordial. Di: "Hola, soy AuraSync. Antes de empezar, necesito tu nombre y apellido."' 
      : `Como ya lo conoces, salúdalo con calidez por su nombre: "¡Hola ${primerNombre}! Qué alegría verte de nuevo."`}

    CONTEXTO DEL CLIENTE:
    ${esNuevo 
      ? 'CLIENTE NUEVO. Tienes prohibido pasar a agendar. Debes solicitar: Nombre, Apellido y Fecha de Nacimiento.' 
      : `CLIENTE REGISTRADO: ${primerNombre}. Ya tienes sus datos, NO los vuelvas a pedir.`}

    Catálogo: ${catalogo}
    Especialistas: ${listaEsp}

    INSTRUCCIONES DE AGENDAMIENTO:
    1. Solo si el cliente ya está registrado (${primerNombre}) puedes proceder a agendar el servicio.
    2. Si el cliente es nuevo y pide cita, dile amablemente: "Con gusto, pero primero necesito registrar tus datos base."
    3. Convierte fechas como "mañana" a YYYY-MM-DD.

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

    // 6. EXTRAER JSON (Súper Reforzado)
    let datosExtraidos = {};
    let citaCreada = false;
    
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    
    if (jsonMatch) {
      try {
        const jsonStr = jsonMatch[1].trim();
        datosExtraidos = JSON.parse(jsonStr);
        console.log('📋 Datos detectados:', datosExtraidos);

        // Guardar/Actualizar cliente (Actualización inmediata de variables)
        if (datosExtraidos.nombre && datosExtraidos.apellido && datosExtraidos.nombre !== "...") {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: (datosExtraidos.apellido && datosExtraidos.apellido !== "...") ? datosExtraidos.apellido.trim() : "",
            fecha_nacimiento: (datosExtraidos.fecha_nacimiento && datosExtraidos.fecha_nacimiento !== "...") ? datosExtraidos.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
          
          console.log('✅ Cliente actualizado en Supabase');
          
          // --- AJUSTE CLAVE: Memoria instantánea ---
          // Actualizamos las variables localmente para que Airtable y la IA las usen YA
          if (!cliente) cliente = {};
          cliente.nombre = datosExtraidos.nombre.trim();
          cliente.apellido = datosExtraidos.apellido !== "..." ? datosExtraidos.apellido.trim() : "";
        }

        // --- AJUSTE CLAVE: Lógica de Cita Blindada ---
        // Solo intentamos agendar si el JSON tiene fecha/hora Y si el cliente YA TIENE NOMBRE en la base de datos o en el JSON
        const tieneFecha = datosExtraidos.cita_fecha && datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/);
        const tieneHora = datosExtraidos.cita_hora && datosExtraidos.cita_hora.match(/^\d{2}:\d{2}$/);
        
        if (tieneFecha && tieneHora && (cliente?.nombre || datosExtraidos.nombre)) {
          const nombreFinal = cliente?.nombre || datosExtraidos.nombre.trim();
          const apellidoFinal = cliente?.apellido || datosExtraidos.apellido.trim();
          
          if (nombreFinal) { // Confirmación extra
            citaCreada = await crearCitaAirtable({
              telefono: userPhone,
              nombre: nombreFinal,
              apellido: apellidoFinal,
              fecha: datosExtraidos.cita_fecha,
              hora: datosExtraidos.cita_hora,
              servicio: datosExtraidos.cita_servicio !== "..." ? datosExtraidos.cita_servicio : "Corte de pelo",
              especialista: datosExtraidos.cita_especialista !== "..." ? datosExtraidos.cita_especialista : "Asignar disponible",
              precio: 0, 
              duracion: 60
            });
          }
        } else {
          console.log('ℹ️ Cita no creada: faltan datos de fecha/hora o el nombre del cliente sigue siendo null.');
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
    
    // Validación extra: Si el nombre es nulo o vacío, no enviamos nada
    if (!datos.nombre || datos.nombre.trim() === "") {
      console.log('⚠️ Airtable: Nombre de cliente vacío, se cancela el envío.');
      return false;
    }

    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": datos.fecha, // Debe ser YYYY-MM-DD
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Notas de la cita": "Agendado por AuraSync",
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
    console.error('❌ ERROR AIRTABLE:', error.response?.data?.error || error.message);
    return false;
  }
}
