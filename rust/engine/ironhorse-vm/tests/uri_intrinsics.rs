//! URI globals must run inside the Ironhorse guest, including catchable errors.
use ironhorse_vm::Interp;

fn guest(source: &str) -> String {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compile guest");
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    let outcome = vm.run(&bytecode);
    assert!(
        outcome.completed,
        "guest halted: {:?}: {source}",
        outcome.halt
    );
    outcome.result
}

#[test]
fn uri_globals_are_callable_with_correct_reserved_sets_and_arity() {
    assert_eq!(guest("[typeof encodeURI, typeof encodeURIComponent, typeof decodeURI, typeof decodeURIComponent].join(',')"), "function,function,function,function");
    assert_eq!(guest("[encodeURI.length, decodeURI.length, encodeURIComponent.length, decodeURIComponent.length].join(',')"), "1,1,1,1");
    assert_eq!(guest("encodeURI('a b/?#&')"), "a%20b/?#&");
    assert_eq!(guest("encodeURIComponent('a b/?#&')"), "a%20b%2F%3F%23%26");
    assert_eq!(guest("decodeURI('%2f%3F%23%20')"), "%2f%3F%23 ");
    assert_eq!(guest("decodeURIComponent('%2f%3F%23%20')"), "/?# ");
    assert_eq!(guest("encodeURIComponent()"), "undefined");
}

#[test]
fn uri_encoding_round_trips_unicode_and_preserves_unescaped_utf16() {
    assert_eq!(
        guest("encodeURIComponent('é😀漢')"),
        "%C3%A9%F0%9F%98%80%E6%BC%A2"
    );
    assert_eq!(
        guest("decodeURIComponent('%C3%A9%F0%9F%98%80%E6%BC%A2')"),
        "é😀漢"
    );
    assert_eq!(
        guest("decodeURIComponent('x\\uD800y').charCodeAt(1)"),
        "55296"
    );
    assert_eq!(guest("decodeURIComponent('%25E2%2582%25AC')"), "%E2%82%AC");
}

#[test]
fn malformed_escapes_and_lone_surrogates_throw_catchable_uri_errors() {
    for expression in [
        "encodeURI('\\uD800')",
        "encodeURIComponent('\\uDC00')",
        "decodeURI('%')",
        "decodeURIComponent('%GG')",
        "decodeURIComponent('%C0%80')",       // overlong UTF-8
        "decodeURIComponent('%ED%A0%80')",    // encoded surrogate
        "decodeURIComponent('%F4%90%80%80')", // above U+10FFFF
        "decodeURIComponent('%E2%82')",       // truncated UTF-8
        "decodeURIComponent('%E2x%82%AC')",   // missing percent separator
    ] {
        let source = format!("var result='miss'; try {{ {expression} }} catch(e) {{ result = (e instanceof URIError)+':'+e.name+':'+e.message }} result");
        assert_eq!(
            guest(&source),
            "true:URIError:URI malformed",
            "{expression}"
        );
    }
}
