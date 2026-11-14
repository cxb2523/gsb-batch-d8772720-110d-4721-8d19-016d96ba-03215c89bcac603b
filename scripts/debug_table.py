import pymysql

conn = pymysql.connect(host='127.0.0.1', user='root', password='123456', database='jd_data')
cur = conn.cursor()

cur.execute("DESCRIBE products")
print("products 表字段:")
for row in cur.fetchall():
    print(f"  - {row[0]}: {row[1]}")

conn.close()
