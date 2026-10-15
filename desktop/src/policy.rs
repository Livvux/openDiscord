use url::Url;

pub fn instance(value: &str) -> Result<Url, &'static str> {
    let url = Url::parse(value).map_err(|_| "Invalid instance URL")?;
    if !safe_https(&url) || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(
            "Instance must be an HTTPS origin without credentials, path, query or fragment",
        );
    }
    Ok(url)
}

pub fn safe_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn same_origin(instance: &Url, target: &Url) -> bool {
    safe_https(target) && instance.origin() == target.origin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_instance() {
        for invalid in [
            "http://example.com",
            "file:///tmp/a",
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com/?x",
            "https://example.com/#a",
            "javascript:alert(1)",
        ] {
            assert!(instance(invalid).is_err(), "{invalid}");
        }
        assert!(instance("https://example.com:8443").is_ok());
    }

    #[test]
    fn pins_scheme_host_port_and_credentials() {
        let base = instance("https://opendiscord.app").unwrap();
        assert!(same_origin(
            &base,
            &Url::parse("https://opendiscord.app/channels?x=1#y").unwrap()
        ));
        assert!(same_origin(
            &base,
            &Url::parse("https://opendiscord.app:443/").unwrap()
        ));
        for target in [
            "https://opendiscord.app.evil.test",
            "https://evil.test",
            "https://opendiscord.app:444",
            "http://opendiscord.app",
            "https://user@opendiscord.app",
            "data:text/html,bad",
            "file:///tmp/a",
            "tauri://localhost",
        ] {
            assert!(
                !same_origin(&base, &Url::parse(target).unwrap()),
                "{target}"
            );
        }
    }
}
