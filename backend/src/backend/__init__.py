def main() -> None:
    import uvicorn

    from backend.settings import Settings

    settings = Settings.from_env()
    uvicorn.run("backend.main:app", host=settings.host, port=settings.port)
