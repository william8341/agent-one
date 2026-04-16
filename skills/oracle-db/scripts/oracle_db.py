#!/usr/bin/env python3
"""
Oracle 数据库资产管理器
"""
import os
import sys
import json
import stat
import argparse

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ASSET_FILE = os.path.join(SKILL_DIR, "oracle_assets.json")
DEFAULT_VAULT_KEY_FILE = os.path.join(SKILL_DIR, ".vault_key")


def load_or_create_key(key_file: str = DEFAULT_VAULT_KEY_FILE) -> bytes:
    from cryptography.fernet import Fernet
    os.makedirs(os.path.dirname(key_file), exist_ok=True)
    if os.path.exists(key_file):
        with open(key_file, "rb") as f:
            return f.read()
    key = Fernet.generate_key()
    with open(key_file, "wb") as f:
        f.write(key)
    os.chmod(key_file, stat.S_IRUSR | stat.S_IWUSR)
    return key


def encrypt(plaintext: str, key_file: str = DEFAULT_VAULT_KEY_FILE) -> str:
    from cryptography.fernet import Fernet
    return "enc:" + Fernet(load_or_create_key(key_file)).encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str, key_file: str = DEFAULT_VAULT_KEY_FILE) -> str:
    if not ciphertext.startswith("enc:"):
        return ciphertext
    from cryptography.fernet import Fernet
    return Fernet(load_or_create_key(key_file)).decrypt(ciphertext[4:].encode()).decode()


def load_assets(path: str = DEFAULT_ASSET_FILE) -> dict:
    if not os.path.exists(path):
        return {"instances": []}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_assets(data: dict, path: str = DEFAULT_ASSET_FILE):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


class OracleDB:
    """Oracle 数据库资产管理器"""

    def __init__(self, asset_file: str = DEFAULT_ASSET_FILE, key_file: str = DEFAULT_VAULT_KEY_FILE):
        self.asset_file = asset_file
        self.key_file = key_file

    def _load(self) -> dict:
        return load_assets(self.asset_file)

    def _save(self, data: dict):
        save_assets(data, self.asset_file)

    def _find(self, name: str) -> dict:
        for inst in self._load()["instances"]:
            if inst["name"] == name:
                return inst
        raise KeyError(f"Oracle instance '{name}' not found")

    def get(self, name: str, user_type: str = "query") -> dict:
        """
        user_type: "query" | "sysdba" | "os"
        """
        inst = self._find(name)
        result = {
            "name": inst["name"],
            "ip": inst["ip"],
            "port": inst.get("port", 1521),
            "sid": inst.get("sid", ""),
            "service_name": inst.get("service_name", ""),
            "adg_peer": inst.get("adg_peer", ""),
        }
        if user_type == "query":
            result["user"] = inst.get("db_query_user", "")
            result["password"] = decrypt(inst.get("db_query_user_password", ""), self.key_file)
        elif user_type == "sysdba":
            result["user"] = inst.get("sysdba_user", "sys")
            result["password"] = decrypt(inst.get("sysdba_user_password", ""), self.key_file)
        elif user_type == "os":
            result["user"] = inst.get("os_user", "")
            result["password"] = decrypt(inst.get("os_password", ""), self.key_file)
            result["ssh_port"] = inst.get("os_ssh_port", 22)
        else:
            raise ValueError(f"Invalid user_type: {user_type}")
        return result

    def dsn(self, name: str) -> str:
        inst = self._find(name)
        ip, port = inst["ip"], inst.get("port", 1521)
        if inst.get("service_name"):
            return f"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={ip})(PORT={port}))(CONNECT_DATA=(SERVICE_NAME={inst['service_name']})))"
        return f"(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={ip})(PORT={port}))(CONNECT_DATA=(SID={inst.get('sid','')})))"

    def peer(self, name: str) -> str:
        return self._find(name).get("adg_peer", "")

    def query(self, **filters) -> list:
        results = self._load()["instances"]
        for k, v in filters.items():
            results = [i for i in results if i.get(k) == v]
        return results

    def all(self) -> list:
        return self._load()["instances"]

    def add(self, data: dict) -> bool:
        asset = self._load()
        if any(i["name"] == data["name"] for i in asset["instances"]):
            return False
        encrypted = dict(data)
        for field in ("db_query_user_password", "sysdba_user_password", "os_password"):
            if field in encrypted and encrypted[field]:
                encrypted[field] = encrypt(encrypted[field], self.key_file)
        asset["instances"].append(encrypted)
        self._save(asset)
        return True

    def update(self, name: str, data: dict) -> bool:
        asset = self._load()
        for i, inst in enumerate(asset["instances"]):
            if inst["name"] == name:
                encrypted = dict(data)
                for field in ("db_query_user_password", "sysdba_user_password", "os_password"):
                    if field in encrypted and encrypted[field]:
                        encrypted[field] = encrypt(encrypted[field], self.key_file)
                asset["instances"][i].update(encrypted)
                self._save(asset)
                return True
        return False

    def delete(self, name: str) -> bool:
        asset = self._load()
        before = len(asset["instances"])
        asset["instances"] = [i for i in asset["instances"] if i["name"] != name]
        if len(asset["instances"]) < before:
            self._save(asset)
            return True
        return False

    def export_md(self) -> str:
        data = self.all()
        md = f"# Oracle 数据库资产清单 ({len(data)} 个实例)\n\n"
        md += "| 名称 | IP | 端口 | SID | 查询用户 | SYSDBA | OS用户 | ADG对端 |\n"
        md += "|------|-----|------|-----|---------|--------|--------|--------|\n"
        for i in data:
            md += f"| {i.get('name','')} | {i.get('ip','')} | {i.get('port',1521)} | {i.get('sid','')} | {i.get('db_query_user','')} | {i.get('sysdba_user','sys')} | {i.get('os_user','')} | {i.get('adg_peer','')} |\n"
        return md


_mgr = None

def _m() -> OracleDB:
    global _mgr
    if _mgr is None:
        _mgr = OracleDB()
    return _mgr

def get(name: str, user_type: str = "query") -> dict:
    return _m().get(name, user_type)

def dsn(name: str) -> str:
    return _m().dsn(name)

def peer(name: str) -> str:
    return _m().peer(name)


def cli():
    p = argparse.ArgumentParser(prog="oracle-db", description="Oracle 数据库资产管理")
    p.add_argument("--asset-file", default=DEFAULT_ASSET_FILE)
    p.add_argument("--key-file", default=DEFAULT_VAULT_KEY_FILE)
    sp = p.add_subparsers(dest="cmd")

    a = sp.add_parser("add", help="添加实例")
    a.add_argument("--name", required=True)
    a.add_argument("--ip", required=True)
    a.add_argument("--port", type=int, default=1521)
    a.add_argument("--sid")
    a.add_argument("--service-name")
    a.add_argument("--db-query-user", required=True)
    a.add_argument("--db-query-user-password", required=True)
    a.add_argument("--sysdba-user", default="sys")
    a.add_argument("--sysdba-user-password", required=True)
    a.add_argument("--os-user")
    a.add_argument("--os-password")
    a.add_argument("--os-ssh-port", type=int, default=22)
    a.add_argument("--adg-peer", help="ADG 对端实例名")
    a.add_argument("--business", default="")
    a.add_argument("--desc", default="")

    q = sp.add_parser("query", help="查询实例")
    q.add_argument("--all", action="store_true")
    q.add_argument("--name")
    q.add_argument("--business")
    q.add_argument("--json", action="store_true", help="JSON 输出")
    q.add_argument("--decrypt", action="store_true", help="解密密码")

    u = sp.add_parser("update", help="更新实例")
    u.add_argument("--name", required=True)
    u.add_argument("--ip")
    u.add_argument("--port", type=int)
    u.add_argument("--db-query-user")
    u.add_argument("--db-query-user-password")
    u.add_argument("--sysdba-user")
    u.add_argument("--sysdba-user-password")
    u.add_argument("--os-user")
    u.add_argument("--os-password")
    u.add_argument("--adg-peer")

    d = sp.add_parser("delete", help="删除实例")
    d.add_argument("--name", required=True)

    ex = sp.add_parser("export", help="导出 Markdown")
    ex.add_argument("--output")

    args = p.parse_args()
    if not args.cmd:
        p.print_help()
        sys.exit(0)

    db = OracleDB(asset_file=args.asset_file, key_file=args.key_file)

    if args.cmd == "add":
        data = {
            "name": args.name, "ip": args.ip, "port": args.port,
            "db_query_user": args.db_query_user,
            "db_query_user_password": args.db_query_user_password,
            "sysdba_user": args.sysdba_user,
            "sysdba_user_password": args.sysdba_user_password,
            "business_system": args.business, "description": args.desc,
        }
        if args.sid: data["sid"] = args.sid
        if args.service_name: data["service_name"] = args.service_name
        if args.os_user:
            data["os_user"] = args.os_user
            data["os_password"] = args.os_password or ""
            data["os_ssh_port"] = args.os_ssh_port
        if args.adg_peer: data["adg_peer"] = args.adg_peer
        ok = db.add(data)
        print(f"✅ 添加成功: {args.name}" if ok else f"❌ '{args.name}' 已存在")

    elif args.cmd == "query":
        if args.name:
            rows = db.query(name=args.name)
        elif args.business:
            rows = db.query(business_system=args.business)
        else:
            rows = db.all()

        if not rows:
            print("未找到匹配的实例")
        elif args.json:
            for i in rows:
                result = {
                    "name": i.get("name"),
                    "ip": i.get("ip"),
                    "port": i.get("port", 1521),
                    "sid": i.get("sid", ""),
                    "db_query_user": i.get("db_query_user", ""),
                    "db_query_user_password": decrypt(i.get("db_query_user_password", "")) if args.decrypt else i.get("db_query_user_password", ""),
                    "sysdba_user": i.get("sysdba_user", "sys"),
                    "sysdba_user_password": decrypt(i.get("sysdba_user_password", "")) if args.decrypt else i.get("sysdba_user_password", ""),
                    "os_user": i.get("os_user", ""),
                    "os_password": decrypt(i.get("os_password", "")) if args.decrypt else i.get("os_password", ""),
                    "os_ssh_port": i.get("os_ssh_port", 22),
                    "adg_peer": i.get("adg_peer", ""),
                }
                print(json.dumps(result))
        else:
            print(f"\n📊 共 {len(rows)} 个实例\n")
            for i in rows:
                print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━")
                print(f"  名称:       {i.get('name')}")
                print(f"  地址:       {i.get('ip')}:{i.get('port',1521)}")
                print(f"  SID:        {i.get('sid','')}")
                print(f"  查询用户:   {i.get('db_query_user')}  (密码: ******)")
                print(f"  SYSDBA:     {i.get('sysdba_user','sys')}  (密码: ******)")
                print(f"  OS用户:     {i.get('os_user','')}  (密码: ******)")
                if i.get("adg_peer"):
                    print(f"  ADG对端:    {i['adg_peer']}")
                if i.get("business_system"):
                    print(f"  业务:       {i['business_system']}")

    elif args.cmd == "update":
        data = {}
        if args.ip: data["ip"] = args.ip
        if args.port: data["port"] = args.port
        if args.db_query_user: data["db_query_user"] = args.db_query_user
        if args.db_query_user_password: data["db_query_user_password"] = args.db_query_user_password
        if args.sysdba_user: data["sysdba_user"] = args.sysdba_user
        if args.sysdba_user_password: data["sysdba_user_password"] = args.sysdba_user_password
        if args.os_user: data["os_user"] = args.os_user
        if args.os_password: data["os_password"] = args.os_password
        if args.adg_peer: data["adg_peer"] = args.adg_peer
        ok = db.update(args.name, data)
        print(f"✅ 更新成功" if ok else f"❌ 未找到 '{args.name}'")

    elif args.cmd == "delete":
        ok = db.delete(args.name)
        print(f"✅ 删除成功" if ok else f"❌ 未找到 '{args.name}'")

    elif args.cmd == "export":
        md = db.export_md()
        if args.output:
            with open(args.output, "w") as f:
                f.write(md)
            print(f"✅ 已导出到 {args.output}")
        else:
            print(md)


if __name__ == "__main__":
    cli()
