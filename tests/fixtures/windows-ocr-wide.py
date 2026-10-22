from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json
# Developer-only fixture source. Python/Pillow are not application dependencies.
root=Path(__file__).parent
font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',14)
lines=json.loads((root/'windows-ocr-wide.json').read_text(encoding='utf-8'))
image=Image.new('RGB',(1920,240),'white');draw=ImageDraw.Draw(image)
for index,line in enumerate(lines):draw.text((12,12+index*42),line,font=font,fill='black')
image.save(root/'windows-ocr-wide.png')
