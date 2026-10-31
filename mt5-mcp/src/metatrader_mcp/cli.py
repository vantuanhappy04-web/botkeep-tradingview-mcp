import click
import os
from dotenv import load_dotenv
from metatrader_mcp.server import mcp
from metatrader_mcp.utils import resolve_transport_config, run_mcp


@click.command()
@click.option("--login", required=False, default=None, type=int, help="MT5 login ID")
@click.option("--password", required=False, default=None, help="MT5 password")
@click.option("--server", required=False, default=None, help="MT5 server name")
@click.option("--path", default=None, help="Path to MT5 terminal executable (optional, auto-detected if not provided)")
@click.option("--transport", default="stdio", type=click.Choice(["stdio", "sse", "streamable-http"], case_sensitive=False), help="MCP transport type (default: stdio)")
@click.option("--host", default="127.0.0.1", help="Host to bind (restricted to 127.0.0.1)")
@click.option("--port", default=8080, type=int, help="Port to bind")
def main(login, password, server, path, transport, host, port):
    """Launch the MetaTrader MCP server."""
    load_dotenv()
    if login is not None:
        os.environ["login"] = str(login)
    if password is not None:
        os.environ["password"] = password
    if server is not None:
        os.environ["server"] = server
    if path:
        os.environ["MT5_PATH"] = path

    transport, host, port = resolve_transport_config(transport, host, port)
    run_mcp(mcp, transport, host, port)


if __name__ == "__main__":
    main()
