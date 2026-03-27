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
    // 1. PROCESAR ENTRADA (mantener igual)
    let textoUsuario = Body || "";
    let esAudio = false;
    
    if (MediaUrl0) {
      esAudio = true;
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
          { url: MediaUrl0 }, 
          { 
            headers: { 
              'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`, 
              'Content-Type': 'application/json' 
            },
            timeout: 15000
          }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        if (!textoUsuario) {
          return res.status(200).send('<Response><Message>No pude escuchar bien. ¿Repetís?</Message></Response>');
        }
      } catch (error) {
        return res.status(200).send('<Response><Message>Problema con el audio. Escribime por favor.</Message></Response>');
      }
    }

    // 2. CARGAR CLIENTE (mantener igual)
    const { data: cliente, error: errorCliente } = await supabase
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

    // 3. CATÁLOGO (mantener igual)
    const { data: especialistas } = await supabase.from('especialistas').select('nombre');
    const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
    
    const listaEspecialistas = especialistas?.map(e => e.nombre).join(', ') || "nuestro equipo";
    const catalogoServicios = servicios?.map(s => `${s.nombre} ($${s.precio})`).join(', ') || "nuestros servicios";
    
    // Mapa de servicios
    const mapaServicios = {};
    servicios?.forEach(s => {
      mapaServicios[s.nombre.toLowerCase()] = s;
      if (s.nombre.toLowerCase().includes('corte')) {
        mapaServicios['cortarme el pelo'] = s;
        mapaServicios['cortar el pelo'] = s;
      }
    });

    // 4. SYSTEM PROMPT (mantener igual que el último que funcionó)
    const systemPrompt = `Eres Aura, la coordinadora de AuraSync. ${esNuevo 
      ? 'Es un cliente NUEVO. Primero pide nombre, apellido y fecha de nacimiento.' 
      : `Es ${primerNombre}. Trátalo solo por su nombre.`}

Catálogo: ${catalogoServicios} | Especialistas: ${listaEspecialistas}

REGLAS:
1. Sé breve y natural (estilo WhatsApp).
2. Convierte fechas naturales a formato técnico automáticamente (tú haces la conversión).
3. Nunca pidas formato YYYY-MM-DD al usuario.

IMPORTANTE: Al final de tu respuesta, incluye EXACTAMENTE este bloque (rellena los datos si los tenés):

DATA_JSON:{
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "fecha_nacimiento": "${cliente?.fecha_nacimiento || ''}",
  "cita_fecha": "...",
  "cita_hora": "...",
  "cita_servicio": "...",
  "cita_especialista": "..."
}:END_JSON`;

    // 5. LLAMADA A OPENAI (mantener igual)
    const messages = [{ role: "system", content: systemPrompt }];
    if (historial) {
      historial.reverse().forEach(msg => messages.push({ role: msg.rol, content: msg.contenido }));
    }
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.3
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }});

    let fullReply = aiRes.data.choices[0].message.content;
    console.log('Respuesta IA:', fullReply);

    // 6. PROCESAMIENTO JSON - CORREGIDO (regex más robusto)
    // Cambié el delimitador final a :END_JSON para evitar conflictos
    const jsonMatch = fullReply.match(/DATA_JSON:([\s\S]*?):END_JSON/);
    let datosExtraidos = {};
    let citaCreada = false;
    
    if (jsonMatch) {
      try {
        const jsonStr = jsonMatch[1].trim();
        datosExtraidos = JSON.parse(jsonStr);
        console.log('✅ Datos extraídos:', datosExtraidos);

        // Guardar datos personales (mantener igual)
        if (esNuevo && datosExtraidos.nombre && datosExtraidos.apellido && 
            datosExtraidos.nombre !== "..." && datosExtraidos.apellido !== "...") {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido.trim(),
            fecha_nacimiento: datosExtraidos.fecha_nacimiento !== "..." ? datosExtraidos.fecha_nacimiento : null
          }, { onConflict: 'telefono' });
          console.log('✅ Cliente guardado');
        }

        // CREAR CITA EN AIRTABLE - CORREGIDO
        if (datosExtraidos.cita_fecha && datosExtraidos.cita_fecha !== "..." && 
            datosExtraidos.cita_hora && datosExtraidos.cita_hora !== "...") {
          
          // Verificar configuración
          if (!AIRTABLE_BASE_ID) {
            console.error('❌ FALTA AIRTABLE_BASE_ID');
          } else if (!AIRTABLE_TOKEN) {
            console.error('❌ FALTA AIRTABLE_TOKEN');
          } else {
            console.log('📅 Creando cita en Airtable...');
            console.log('Base ID:', AIRTABLE_BASE_ID.substring(0, 10) + '...');
            console.log('Tabla:', AIRTABLE_TABLE_NAME);
            
            const servicioKey = datosExtraidos.cita_servicio?.toLowerCase();
            const infoServicio = mapaServicios[servicioKey] || { 
              nombre: datosExtraidos.cita_servicio, 
              precio: 0, 
              duracion: 60 
            };
            
            citaCreada = await crearCitaAirtable({
              telefono: userPhone,
              nombre: datosExtraidos.nombre || cliente?.nombre,
              apellido: datosExtraidos.apellido || cliente?.apellido,
              esPrimeraVez: esNuevo,
              fecha: datosExtraidos.cita_fecha,
              hora: datosExtraidos.cita_hora,
              servicio: infoServicio.nombre,
              especialista: datosExtraidos.cita_especialista || "Cualquiera",
              precio: infoServicio.precio,
              duracion: infoServicio.duracion
            });
          }
        }
      } catch (e) {
        console.error('❌ Error procesando:', e);
      }
    } else {
      console.log('⚠️ No se encontró DATA_JSON en:', fullReply.substring(fullReply.length - 200));
    }

    // Limpiar respuesta
    let cleanReply = fullReply.replace(/DATA_JSON:[\s\S]*?:END_JSON/, '').trim();
    if (citaCreada) {
      cleanReply += `\n\n✅ ¡Cita registrada!`;
    }

    // Guardar conversación (mantener igual)
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('Error:', err);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Hubo un error técnico.</Message></Response>');
  }
}

// FUNCIÓN CORREGIDA PARA AIRTABLE
async function crearCitaAirtable(datos) {
  try {
    const nombreCompleto = `${datos.nombre || ''} ${datos.apellido || ''}`.trim();
    
    // CORRECCIÓN 1: Verificar que la URL sea correcta
    // Asegurar que no haya undefined en la URL
    if (!AIRTABLE_BASE_ID || AIRTABLE_BASE_ID === 'undefined') {
      console.error('❌ AIRTABLE_BASE_ID no está definido');
      return false;
    }

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;
    console.log('🔗 URL:', url);

    const fields = {
      "Cliente": nombreCompleto || "Sin nombre",
      "Servicio": datos.servicio || "No especificado",
      "Fecha": datos.fecha,
      "Especialista": datos.especialista,
      "Teléfono": datos.telefono,
      "Estado": "Confirmada",
      "Notas de la cita": "Agendado por WhatsApp",
      "Email de cliente": "",
      "¿Es primera vez?": datos.esPrimeraVez ? "Sí" : "No",
      "Cliente VIP": "No",
      "Duración estimada (minutos)": parseInt(datos.duracion) || 60,
      "Importe estimado": parseFloat(datos.precio) || 0,
      "Observaciones de confirmación": new Date().toLocaleString('es-ES')
    };

    console.log('📋 Campos:', JSON.stringify(fields, null, 2));

    const response = await axios.post(
      url,
      { records: [{ fields }] },
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Cita creada. ID:', response.data.records[0].id);
    return true;
    
  } catch (error) {
    console.error('❌ Error Airtable:');
    console.error('Status:', error.response?.status);
    console.error('Error:', error.response?.data?.error || error.message);
    
    if (error.response?.status === 404) {
      console.error('💡 El error 404 significa que la base o tabla no existe.');
      console.error('   Verifica que AIRTABLE_BASE_ID sea correcto (empieza con app...)');
      console.error('   Verifica que AIRTABLE_TABLE_NAME sea exactamente:', AIRTABLE_TABLE_NAME);
    }
    if (error.response?.status === 403) {
      console.error('💡 Error 403: El token no tiene permisos o es inválido');
    }
    
    return false;
  }
}
