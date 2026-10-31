import logging
import os
from typing import Any, Optional, Union
from metatrader_client import client

logger = logging.getLogger("metatrader_mcp")


def resolve_transport_config(transport=None, host=None, port=None):
    """Resolve transport config: default to local stdio and 127.0.0.1."""
    transport = transport or os.getenv("MCP_TRANSPORT", "stdio")
    host = host or os.getenv("MCP_HOST", "127.0.0.1")
    port = port if port is not None else int(os.getenv("MCP_PORT", "8080"))
    return transport, host, port


def run_mcp(mcp, transport, host, port):
    """Run the MCP server with the resolved transport config."""
    if transport == "stdio":
        mcp.run(transport="stdio")
    else:
        mcp.settings.host = host
        mcp.settings.port = port
        try:
            from mcp.server.transport_security import TransportSecuritySettings
            mcp.settings.transport_security = TransportSecuritySettings(
                enable_dns_rebinding_protection=False
            )
        except Exception:
            pass
        mcp.run(transport=transport)


def build_client_from_env(
    login: Optional[Union[str, int]] = None,
    password: Optional[str] = None,
    server: Optional[str] = None,
    path: Optional[str] = None,
) -> client.MT5Client:
    config: dict[str, Any] = {}
    login = login if login is not None else os.getenv("login") or os.getenv("MT5_LOGIN")
    password = password if password is not None else os.getenv("password") or os.getenv("MT5_PASSWORD")
    server = server if server is not None else os.getenv("server") or os.getenv("MT5_SERVER")
    path = path if path is not None else os.getenv("MT5_PATH")
    portable_raw = (os.getenv("MT5_PORTABLE") or "").strip().lower()

    if login and password and server:
        config["login"] = int(login)
        config["password"] = str(password)
        config["server"] = str(server)
    if path:
        config["path"] = path
    if portable_raw in ("1", "true", "yes"):
        config["portable"] = True

    return client.MT5Client(config=config)


def init(
    login: Optional[Union[str, int]],
    password: Optional[str],
    server: Optional[str],
    path: Optional[str] = None,
    allow_lazy: bool = True,
) -> client.MT5Client:
    """
    Initialize MT5Client.
    If terminal64.exe is still booting when allow_lazy=True, keep the client
    instance alive and reconnect automatically on the first tool invocation.
    """
    mt5_client = build_client_from_env(login=login, password=password, server=server, path=path)
    try:
        mt5_client.connect()
    except Exception as exc:
        if not allow_lazy:
            raise
        logger.warning("Initial MT5 connect deferred (will retry on tool call): %s", exc)
    return mt5_client


def get_client(ctx: Any) -> client.MT5Client:
    c = getattr(ctx.request_context.lifespan_context, "client", None)
    if c is None:
        c = build_client_from_env()
        ctx.request_context.lifespan_context.client = c
    if not c.is_connected():
        c.connect()
    return c
