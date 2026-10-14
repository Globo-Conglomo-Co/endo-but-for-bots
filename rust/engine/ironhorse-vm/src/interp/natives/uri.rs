//! ECMAScript URI globals. Operate on JS UTF-16 code units, not Rust strings:
//! encoding rejects lone surrogates, while decoding preserves unescaped ones.
use super::super::*;

const HEX: &[u8; 16] = b"0123456789ABCDEF";

fn unescaped(byte: u8, component: bool) -> bool {
    byte.is_ascii_alphanumeric()
        || b"-_.!~*'()".contains(&byte)
        || (!component && b";/?:@&=+$,#".contains(&byte))
}

fn hex_digit(unit: u16) -> Option<u8> {
    let byte = u8::try_from(unit).ok()?;
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_byte(units: &[u16], pos: usize) -> Option<u8> {
    if units.get(pos) != Some(&(b'%' as u16)) {
        return None;
    }
    Some((hex_digit(*units.get(pos + 1)?)? << 4) | hex_digit(*units.get(pos + 2)?)?)
}

fn encode_uri(units: &[u16], component: bool) -> Option<Vec<u16>> {
    let mut out = Vec::with_capacity(units.len());
    for scalar in char::decode_utf16(units.iter().copied()) {
        let scalar = scalar.ok()?; // A lone surrogate is a URIError.
        if scalar.is_ascii() && unescaped(scalar as u8, component) {
            out.push(scalar as u16);
            continue;
        }
        let mut bytes = [0u8; 4];
        for byte in scalar.encode_utf8(&mut bytes).as_bytes() {
            out.extend([
                b'%' as u16,
                HEX[(byte >> 4) as usize] as u16,
                HEX[(byte & 15) as usize] as u16,
            ]);
        }
    }
    Some(out)
}

fn decode_uri(units: &[u16], component: bool) -> Option<Vec<u16>> {
    let mut out = Vec::with_capacity(units.len());
    let mut pos = 0;
    while pos < units.len() {
        if units[pos] != b'%' as u16 {
            out.push(units[pos]);
            pos += 1;
            continue;
        }
        let first = percent_byte(units, pos)?;
        let width = match first {
            0..=0x7f => 1,
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return None,
        };
        let mut bytes = [0u8; 4];
        bytes[0] = first;
        for (offset, byte) in bytes.iter_mut().enumerate().take(width).skip(1) {
            *byte = percent_byte(units, pos + offset * 3)?;
        }
        let scalar = std::str::from_utf8(&bytes[..width]).ok()?.chars().next()?;
        if width == 1 && !component && b";/?:@&=+$,#".contains(&first) {
            out.extend_from_slice(&units[pos..pos + 3]);
        } else {
            out.extend(scalar.encode_utf16(&mut [0u16; 2]).iter().copied());
        }
        pos += width * 3;
    }
    Some(out)
}

impl Interp {
    pub(in crate::interp) fn call_uri(
        &mut self,
        method: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let value = if argc > 0 {
            self.stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::undefined()
        };
        let units = self.to_string_units(code, value)?;
        let component = matches!(
            method,
            NativeMethod::UriEncodeComponent | NativeMethod::UriDecodeComponent
        );
        let result = match method {
            NativeMethod::UriEncode | NativeMethod::UriEncodeComponent => {
                encode_uri(&units, component)
            }
            NativeMethod::UriDecode | NativeMethod::UriDecodeComponent => {
                decode_uri(&units, component)
            }
            _ => unreachable!(),
        };
        match result {
            Some(units) => Ok(self.new_string_units(&units)),
            None => {
                let error = self.internal_error("URIError", "URI malformed".into());
                Err(self.raise_js(error))
            }
        }
    }
}
