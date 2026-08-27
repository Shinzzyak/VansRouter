#!/usr/bin/env python3
"""Insert ZAI provider node + connection into VansRouter DB (DB-direct route).

Node:   openai-compatible (prefix 'zai'), baseUrl http://127.0.0.1:8879/v1
Conn:   points apiKey='zai-local' (sidecar ignores auth), authType apikey.

The sidecar (zai_sidecar.py :8879) is a local OpenAI-compatible proxy that
UI-drives chat.z.ai (signature+captcha handled in-browser). It ignores the
Bearer token, so the connection apiKey is cosmetic.

Usage: python3 insert_zai_node.py
"""
import sqlite3, json, uuid
from datetime import datetime

DB = "/home/ubuntu/VansRouter/data/db/data.sqlite"
SIDECAR_BASE = "http://127.0.0.1:8879/v1"  # stored base; router appends /chat/completions
PREFIX = "zai"
NODE_NAME = "ZAI GLM (UI-drive)"
NODE_ID = f"openai-compatible-chat-{uuid.uuid4()}"


def now():
    return datetime.utcnow().isoformat() + "Z"


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # --- NODE ---
    cur.execute("SELECT id FROM providerNodes WHERE id=?", (NODE_ID,))
    if not cur.fetchone():
        node_data = json.dumps({"prefix": PREFIX, "apiType": "chat", "baseUrl": SIDECAR_BASE})
        cur.execute(
            "INSERT INTO providerNodes(id,type,name,data,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
            (NODE_ID, "openai-compatible", NODE_NAME, node_data, now(), now()),
        )
        print(f"[node] inserted {NODE_ID} (prefix {PREFIX}/)")
    else:
        print(f"[node] already exists {NODE_ID}")

    # --- CONNECTION ---
    conn_id = str(uuid.uuid4())
    conn_data = json.dumps({
        "apiKey": "zai-local",  # sidecar ignores auth
        "testStatus": "active",
        "providerSpecificData": {
            "prefix": PREFIX,
            "apiType": "chat",
            "baseUrl": SIDECAR_BASE,
            "nodeName": NODE_NAME,
            "connectionProxyEnabled": False,
            "connectionProxyUrl": "",
            "connectionNoProxy": "",
        },
        "errorCode": None,
        "backoffLevel": 0,
    })
    cur.execute(
        "INSERT INTO providerConnections(id,provider,authType,name,email,priority,isActive,data,createdAt,updatedAt) "
        "VALUES(?,?,?,?,?,?,?,?,?,?)",
        (conn_id, NODE_ID, "apikey", "ZAI Local", None, 141, 1, conn_data, now(), now()),
    )
    print(f"[conn] inserted {conn_id} -> {NODE_ID}")

    conn.commit()
    conn.close()
    print("done. model address: zai/glm-5.3-flash, zai/glm-5.2, etc.")


if __name__ == "__main__":
    main()