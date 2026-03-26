import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Citas';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();
  
  try {
    // 1. TRANSCRIPCIÓN (SI ES AUDIO)
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post(
        "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
        { url: MediaUrl0 }, 
        { 
          headers: { 
            'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 
            'Content-Type': 'application/json' 
          }
        }
      );
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // 2. CARGAR CLIENTE EXISTENTE
    const { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .single();

    // Determinar estado claramente
    const esClienteNuevo = !cliente || !cliente.nombre;
    
    // 3. CARGAR CATÁLOGO
    const { data: esp } = await supabase.from('especialistas').select('nombre');
    const { data: serv } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const listaEsp = esp?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogo = serv?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "nuestros servicios";
    
    const serviciosMap = {};
    serv?.forEach(s => {
      serviciosMap[s.nombre.toLowerCase()] = {
        precio: s.precio,
        duracion: s.duracion || 60
      };
    });

    // 4. SYSTEM PROMPT CON CONTEXTO CLARO
    const nombreCliente = cliente?.nombre || null;
    const apellidoCliente = cliente?.apellido || null;
    
    const systemPrompt = `Eres la Asistente de AuraSync. ${
      esClienteNuevo 
        ? 'Este es un CLIENTE NUEVO (teléfono no registrado). Debes saludar cordialmente y pedir SOLO: Nombre, Apellido y Fecha de Nacimiento antes de agendar.' 
        : `Este es un CLIENTE EXISTENTE. Su nombre es ${nombreCliente} ${apellidoCliente || ''}. Salúdalo por su nombre (${nombreCliente}) y ofrécele agendar directamente.`
    }

DATOS DEL LOCAL:
- Especialistas: ${listaEsp}
- Servicios: ${catalogo}

REGLAS:
1. Nunca digas que eres una IA. Eres la coordinadora del salón.
2. ${esClienteNuevo ? 'NO agendes nada hasta obtener Nombre, Apellido y Fecha de Nacimiento.' : 'Ofrece agendar directamente, usa su nombre en la conversación.'}
3. Mantén respuestas breves para WhatsApp.

FORMATO FECHAS:
- cita_fecha: YYYY-MM-DD (ej: 2026-03-27)
- cita_hora: HH:MM (ej: 14:30)

AL FINAL agrega SIEMPRE:
DATA_JSON:{
  "nombre": "${nombreCliente || ''}",
  "apellido": "${apellidoCliente || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "...",
  "cita_hora": "...",
  "cita_servicio": "...",
  "cita_especialista": "..."
}:DATA_JSON`;

    // 5. RESPUESTA IA
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt }, 
        { role: "user", content: textoUsuario }
      ],
      temperature: 0.3
    }, { 
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
    });

    let fullReply = aiRes.data.choices[0].message.content;

    // 6. PROCESAMIENTO JSON Y GUARDADO
    const jsonMatch = fullReply.match(/DATA_JSON:\s*(\{[\s\S]*?\})\s*:DATA_JSON/);
    
    if (jsonMatch) {
      try {
        const jsonLimpio = jsonMatch[1].replace(/\n/g, '').trim();
        const datosExtraidos = JSON.parse(jsonLimpio);
        
        // Solo guardar datos personales si son válidos (no "..." y no vacíos)
        if (datosExtraidos.nombre && 
            datosExtraidos.nombre !== "..." && 
            datosExtraidos.nombre !== "" &&
            datosExtraidos.apellido && 
            datosExtraidos.apellido !== "...") {
          
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido.trim(),
            fecha_nacimiento: (datosExtraidos.fecha_nacimiento && datosExtraidos.fecha_nacimiento !== "...") 
              ? datosExtraidos.fecha_nacimiento 
              : null
          }, { onConflict: 'telefono' });
        }

        // Crear cita en Airtable si hay datos completos
        if (datosExtraidos.cita_fecha && 
            datosExtraidos.cita_fecha !== "..." && 
            datosExtraidos.cita_hora && 
            datosExtraidos.cita_hora !== "..." &&
            AIRTABLE_BASE_ID && 
            AIRTABLE_TOKEN) {
          
          const servicioKey = datosExtraidos.cita_servicio?.toLowerCase();
          const infoServicio = serviciosMap[servicioKey] || { precio: 0, duracion: 60 };
          
          await crearCitaAirtable({
            telefono: userPhone,
            nombre: datosExtraidos.nombre || cliente?.nombre,
            apellido: datosExtraidos.apellido || cliente?.apellido,
            esPrimeraVez: esClienteNuevo,
            fecha: datosExtraidos.cita_fecha,
            hora: datosExtraidos.cita_hora,
            servicio: datosExtraidos.cita_servicio,
            especialista: datosExtraidos.cita_especialista,
            precio: infoServicio.precio,
            duracion: infoServicio.duracion,
            notas: `Agendado por WhatsApp`
          });
        }
      } catch (e) {
        console.error('Error procesando:', e);
      }
    }

    // Limpiar y enviar respuesta
    const cleanReply = fullReply.replace(/DATA_JSON:[\s\S]*?:DATA_JSON/, '').trim();
    
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('Error:', err);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Hubo un inconveniente técnico, ¿me repites?</Message></Response>');
  }
}

async function crearCitaAirtable(datos) {
  try {
    const nombreCompleto = `${datos.nombre || ''} ${datos.apellido || ''}`.trim();
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
    
    await axios.post(
      url,
      {
        records: [{
          fields: {
            "Cliente": nombreCompleto,
            "Servicio": datos.servicio || "No especificado",
            "Fecha": datos.fecha,
            "Especialista": datos.especialista || "No asignado",
            "Teléfono": datos.telefono,
            "Estado": "Confirmada",
            "Notas de la cita": datos.notas,
            "Email de cliente": "",
            "¿Es primera vez?": datos.esPrimeraVez ? "Sí" : "No",
            "Cliente VIP": "No",
            "Duración estimada (minutos)": parseInt(datos.duracion) || 60,
            "Importe estimado": parseFloat(datos.precio) || 0,
            "Observaciones de confirmación": new Date().toLocaleString('es-ES')
          }
        }]
      },
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Cita creada en Airtable');
  } catch (error) {
    console.error('❌ Error Airtable:', error.response?.data || error.message);
  }
}
