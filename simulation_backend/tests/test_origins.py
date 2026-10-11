from app.main import origin_allowed


def test_explicit_origin_allowlist() -> None:
    allowed = ["https://routz-sim.vercel.app"]
    assert origin_allowed(None, allowed)
    assert origin_allowed("https://routz-sim.vercel.app", allowed)
    assert not origin_allowed("https://preview-routz.vercel.app", allowed)


def test_wildcard_allows_vercel_preview_origins() -> None:
    assert origin_allowed("https://any-preview.vercel.app", ["*"])
