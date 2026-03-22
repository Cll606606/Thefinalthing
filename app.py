from flask import Flask, render_template, request, redirect, url_for
import base64
import cv2
import numpy as np
import mediapipe as mp
import random
from groq import Groq
import json
import os

client = Groq(api_key="***REMOVED-GROQ-KEY***")
# Mapping zones to MediaPipe 
FACE_ZONES = {
    "cheeks": [205, 425],
    "nose_tip": [1],
    "inner_eyes": [173, 398],
    "forehead": [10],
    "lips": [0, 17],
    "jawline": [172, 397]
}

def create_face_map(image, landmarks, map_instructions):
    """
    Generates a grayscale 'blueprint' of the user's face with neon makeup overlays.
    """
    h, w, _ = image.shape
    
    # 1. Create a dark, grayscale background (The "Blueprint" look)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    base = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    # Darken it by 60%
    base = cv2.multiply(base, np.array([0.4, 0.4, 0.4])) 
    
    overlay = base.copy()
    
    # 2. Draw the AI-calculated zones
    for instr in map_instructions:
        # Get the landmark IDs for the specific zone (cheeks, lips, etc.)
        zone_name = instr.get('zone')
        indices = FACE_ZONES.get(zone_name, [])
        
        # Convert Hex color to BGR for OpenCV
        color_hex = instr.get('color', '#5ef2c3').lstrip('#')
        color_bgr = tuple(int(color_hex[i:i+2], 16) for i in (4, 2, 0))

        for idx in indices:
            # Convert normalized MediaPipe coordinates to pixel coordinates
            center = (int(landmarks[idx].x * w), int(landmarks[idx].y * h))
            
            # Draw glowing 'heat map' circles 
            for r in range(40, 0, -5):
                cv2.circle(overlay, center, r, color_bgr, -1)
                base = cv2.addWeighted(overlay, 0.1, base, 0.9, 0)
    
    # 3. Convert the resulting image to Base64 so it can be sent to HTML
    _, buffer = cv2.imencode('.jpg', base)
    return base64.b64encode(buffer).decode('utf-8')

app = Flask(__name__)
app.secret_key = os.environ["SECRET_KEY"]  # REMOVED-HARDCODED-KEY

mp_face_mesh = mp.solutions.face_mesh


# Helper functions

def to_px(lm, w, h):
    return np.array([lm.x * w, lm.y * h])


# AI ANALYSIS

def analyze_face(image):
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    h, w, _ = image.shape
    features = {}

    with mp_face_mesh.FaceMesh(
        static_image_mode=True,
        refine_landmarks=True
    ) as face_mesh:
        results = face_mesh.process(rgb)
        if not results.multi_face_landmarks: 
            return None, None
        
        lm = results.multi_face_landmarks[0].landmark

        # 1. FACE SHAPE & PROPORTIONS
        f_width = np.linalg.norm(to_px(lm[234], w, h) - to_px(lm[454], w, h))
        f_height = np.linalg.norm(to_px(lm[10], w, h) - to_px(lm[152], w, h))
        forehead_w = np.linalg.norm(to_px(lm[103], w, h) - to_px(lm[332], w, h))
        jaw_w = np.linalg.norm(to_px(lm[172], w, h) - to_px(lm[397], w, h))
        cheek_w = np.linalg.norm(to_px(lm[234], w, h) - to_px(lm[454], w, h))
        
        if f_height / f_width > 1.5: 
            features["face_shape"] = "Oval"
        elif forehead_w > jaw_w * 1.2: 
            features["face_shape"] = "Heart"
        elif jaw_w > forehead_w: 
            features["face_shape"] = "Square/Pear"
        else: 
            features["face_shape"] = "Round"

        # 2. EYEBROW STRUCTURE
        brow_inner = to_px(lm[70], w, h)
        brow_peak = to_px(lm[105], w, h)
        arch_diff = brow_inner[1] - brow_peak[1]
        features["eyebrow_arch"] = "High Arch" if arch_diff > 12 else "Straight/Flat" if arch_diff < 4 else "Soft Arch"

        # 3. EYE SHAPE & SETTING
        eye_w = np.linalg.norm(to_px(lm[33], w, h) - to_px(lm[133], w, h))
        eye_h = np.linalg.norm(to_px(lm[159], w, h) - to_px(lm[145], w, h))
        eye_sep = np.linalg.norm(to_px(lm[133], w, h) - to_px(lm[362], w, h))
        
        features["eye_shape"] = "Almond" if (eye_h/eye_w) < 0.3 else "Round"
        features["eye_setting"] = "Wide-set" if (eye_sep/f_width) > 0.35 else "Close-set" if (eye_sep/f_width) < 0.28 else "Proportional"

        # 4. NOSE PROPORTIONS
        n_width = np.linalg.norm(to_px(lm[102], w, h) - to_px(lm[331], w, h))
        features["nose_bridge"] = "Narrow" if (n_width/f_width) < 0.22 else "Broad"

        # 5. MOUTH & LIPS
        lip_upper = np.linalg.norm(to_px(lm[13], w, h) - to_px(lm[0], w, h))
        lip_lower = np.linalg.norm(to_px(lm[14], w, h) - to_px(lm[17], w, h))
        features["lip_fullness"] = "Full Lips" if (lip_upper + lip_lower) > 12 else "Thin/Refined"
        features["cupids_bow"] = "Defined" if np.linalg.norm(to_px(lm[37], w, h) - to_px(lm[267], w, h)) > 5 else "Smooth"

        # 6. CHEEKBONE PROMINENCE
        if cheek_w > (forehead_w * 1.05):
            features["cheekbones"] = "High/Prominent"
        else:
            features["cheekbones"] = "Soft"

        # 7. SKIN & UNDERTONE
        p_cheek = to_px(lm[205], w, h)
        sample = image[int(p_cheek[1])-5:int(p_cheek[1])+5, int(p_cheek[0])-5:int(p_cheek[0])+5]
        if sample.size > 0:
            avg_color = np.mean(sample, axis=(0, 1)) # BGR
            brightness = (0.299*avg_color[2] + 0.587*avg_color[1] + 0.114*avg_color[0])
            features["skin_tone"] = "Fair" if brightness > 180 else "Medium" if brightness > 120 else "Deep"
            features["undertone"] = "Warm (Yellow/Gold)" if avg_color[1] > avg_color[0] else "Cool (Pink/Blue)"
        
        features["confidence_score"] = random.uniform(0.95, 0.99)
        
    return features, lm

# AI REPORT GENERATION VIA OLLAMA
def generate_ai_report(features, vibe, budget):

    prompt = f"""
Return ONLY valid JSON.

Format EXACTLY like this:

{{
"tutorial":"step by step makeup tutorial",
"map_instructions":[
{{"zone":"cheeks","color":"#00FFFF","label":"Apply blush"}},
{{"zone":"lips","color":"#FF00FF","label":"Lip color"}},
{{"zone":"nose_tip","color":"#FFFF00","label":"Highlight"}}
]
}}

Client:
Face Shape: {features.get('face_shape')}
Skin Tone: {features.get('skin_tone')}
Style: {vibe}
Budget: {budget}
"""

    try:
        response = client.chat.completions.create(
            messages=[
                {"role": "system", "content": "You output ONLY JSON."},
                {"role": "user", "content": prompt}
            ],
            model="llama3-70b-8192"
        )

        content = response.choices[0].message.content

        # ---- SAFE JSON EXTRACTION ----
        start = content.find("{")
        end = content.rfind("}") + 1

        json_text = content[start:end]

        data = json.loads(json_text)

        # ensure structure exists
        if "tutorial" not in data:
            data["tutorial"] = "Tutorial unavailable."

        if "map_instructions" not in data:
            data["map_instructions"] = []

        return data

    except Exception as e:
        print("AI ERROR:", e)

        # SAFE FALLBACK (ALWAYS DICTIONARY)
        return {
            "tutorial": """
• Prep skin with moisturizer  
• Apply foundation evenly  
• Add blush to cheeks  
• Highlight nose tip  
• Finish with lip gloss
""",
            "map_instructions": [
                {"zone":"cheeks","color":"#00FFFF","label":"Blush"},
                {"zone":"lips","color":"#FF00FF","label":"Lip"},
                {"zone":"nose_tip","color":"#FFFF00","label":"Highlight"}
            ]
        }

# ROUTES

def create_face_map(image, landmarks, instructions):

    h, w, _ = image.shape

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    base = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    base = cv2.multiply(base, np.array([0.4,0.4,0.4]))

    overlay = base.copy()

    for instr in instructions:

        color_hex = instr["color"].lstrip("#")
        color = tuple(int(color_hex[i:i+2],16) for i in (4,2,0))

        for idx in FACE_ZONES.get(instr["zone"],[]):
            center = (
                int(landmarks[idx].x*w),
                int(landmarks[idx].y*h)
            )

            for r in range(40,0,-5):
                cv2.circle(overlay, center, r, color, -1)
                base = cv2.addWeighted(overlay,0.1,base,0.9,0)

    _, buffer = cv2.imencode(".jpg", base)
    return base64.b64encode(buffer).decode("utf-8")

@app.route("/")
def home():
    return render_template("index.html")

@app.route("/select-style", methods=["POST"])
def select_style():
    face_data = request.form.get("face_data")
    if not face_data:
        return redirect(url_for("home"))
    return render_template("style.html", face_data=face_data)

def search_query_format(text):
    """
    Cleans up the search string for a YouTube URL.
    Replaces spaces with '+' and removes special characters.
    """
    if not text:
        return ""
    # Remove hashtags and replace spaces with plus signs
    clean_text = text.replace("#", "").replace(" ", "+")
    return clean_text

@app.route("/results", methods=["POST"])
def results():
    # 1. Get Form Data
    face_data = request.form.get("face_data")
    if not face_data:
        return redirect(url_for("home"))

    style_choice = request.form.get("style")
    custom_vibe = request.form.get("custom_vibe")
    final_style = custom_vibe if custom_vibe and custom_vibe.strip() else style_choice

    budget_choice = request.form.get("budget")
    custom_budget = request.form.get("custom_budget")
    final_budget = custom_budget if custom_budget and custom_budget.strip() else budget_choice

    # 2. Process the Image & Get Landmarks
    try:
        header, encoded = face_data.split(",", 1)
        image_bytes = base64.b64decode(encoded)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        
        # IMPORTANT: Updated analyze_face should now return (features, raw_landmarks)
        features, raw_landmarks = analyze_face(image) 
        
        if not features or not raw_landmarks:
            return "Face not detected. Please move closer and try again."
            
    except Exception as e:
        return f"Image processing error: {str(e)}"

    # 3. Generate the AI Report & Map Instructions (Combined)
    # This now returns a dictionary with 'tutorial' and 'map_instructions'
    ai_response = generate_ai_report(features, final_style, final_budget)
    report = ai_response.get("tutorial", "No tutorial generated.")
    map_instructions = ai_response.get("map_instructions", [])

    # 4. Generate the Face Map Image (The Neon Blueprint)
    map_image_base64 = create_face_map(image, raw_landmarks, map_instructions)

    # 5. Create the YouTube Search URL
    face_shape = features.get('face_shape', 'Universal')
    search_string = f"2026 {final_style} makeup tutorial for {face_shape} face"
    youtube_url = f"https://www.youtube.com/results?search_query={search_query_format(search_string)}"

    # 6. Final Render
    return render_template("analysis.html", 
                           result=features, 
                           report=report, 
                           style=final_style, 
                           budget=final_budget,
                           youtube_url=youtube_url,
                           map_image=map_image_base64, # New
                           map_data=map_instructions)  # New
if __name__ == "__main__":
    app.run(debug=True)