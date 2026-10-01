import os
import zipfile
import subprocess

# Jina la faili lako la ZIP
zip_filename = "Dvary Host Ultimate.zip" 

print("1. Inafungua faili lako la ZIP...")
with zipfile.ZipFile(zip_filename, 'r') as zip_ref:
    zip_ref.extractall(".")
    print("   -> Mafaili yamegawanyika kikamilifu!")

print("2. Inatuma mafaili yaliyogawanyika kwenda GitHub...")
subprocess.run(["git", "add", "."])
subprocess.run(["git", "commit", "-m", "Auto extract Dvary Host Ultimate ZIP"])
subprocess.run(["git", "push", "-u", "origin", "main"])

print("Imekamilika! Kila kitu kimetua GitHub kikiwa kimegawanyika.")

