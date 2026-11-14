from fpdf import FPDF
from datetime import datetime

"""
Python Automation Hub - Daily Task Logger
Goal: Convert your daily tasks into a clean PDF report.
"""

class PDF(FPDF):
    def header(self):
        self.set_font('Arial', 'B', 12)
        self.cell(0, 10, f'Daily Activity Report - {datetime.now().strftime("%Y-%m-%d")}', 0, 1, 'C')
        self.ln(10)

def create_report():
    print("--- Daily Task Logger ---")
    tasks = []
    while True:
        task = input("Enter a task (or type 'done' to finish): ")
        if task.lower() == 'done':
            break
        tasks.append(task)

    if not tasks:
        print("No tasks entered. Exiting...")
        return

    pdf = PDF()
    pdf.add_page()
    pdf.set_font("Arial", size=12)

    for i, task in enumerate(tasks, 1):
        pdf.cell(0, 10, f"{i}. {task}", 0, 1)

    output_file = f"Report_{datetime.now().strftime('%Y%m%d')}.pdf"
    pdf.output(output_file)
    print(f"[✔] Report generated: {output_file}")

if __name__ == "__main__":
    create_report()