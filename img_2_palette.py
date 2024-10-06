from tkinter import *
from tkinter import filedialog
import tkinter as tk
from PIL import Image, ImageTk
from skimage import color
from skimage.color import deltaE_ciede2000
import numpy as np
import os

class Img2Palette:
    def __init__(self, root):
        self.root = root
        self.img = None
        self.palette = None
        self.file_path = None

        self.setup_ui()

    def setup_ui(self):
        self.root.title("Img2Palette")
        self.root.geometry("250x420")
        self.root.resizable(False, False)

        self.image_frame = Frame(self.root, height=250)
        self.image_frame.pack()

        self.img_label = Label(self.root)
        self.img_label.pack()

        get_image_button = Button(self.root, text="Select Image", command=self.get_image)
        get_image_button.pack(pady=5)

        scale_label = Label(self.root, text="Colors in Palette:")
        scale_label.pack(pady=(5, 0))

        self.scale = Scale(self.root, from_=1, to=256, orient=HORIZONTAL, highlightthickness=0)
        self.scale.pack()
        self.scale.focus_set()

        self.scale.bind("<Left>", self.decrease_scale)
        self.scale.bind("<Down>", self.decrease_scale)
        self.scale.bind("<Right>", self.increase_scale)
        self.scale.bind("<Up>", self.increase_scale)

        create_palette_button = Button(self.root, text="Save Color Palette", command=self.create_and_save_palette)
        create_palette_button.pack(pady=5)

    def get_image(self):
        self.file_path = filedialog.askopenfilename()
        self.img = Image.open(self.file_path)
        self.img = self.img.convert('RGB')
        max_colors = min(len(set(self.img.getdata())), 256)
        self.scale.config(to=max_colors)
        max_size = (250, 250)
        self.img.thumbnail(max_size, Image.LANCZOS)
        self.image_frame.pack_forget()
        img_preview = ImageTk.PhotoImage(self.img)
        self.img_label.config(image=img_preview)
        self.img_label.image = img_preview

    def create_and_save_palette(self):
        num_colors = self.scale.get()
        small_img = self.img.resize((256, 256))
        result = small_img.quantize(colors=num_colors)
        result = result.convert('RGB')
        colors = result.getcolors(num_colors)
        lab_colors = [color.rgb2lab(np.array([[col]])/255)[0][0] for count, col in colors]
        lab_colors.sort(key=lambda x: x[0])
        sorted_lab_colors = [lab_colors.pop(0)]
        while lab_colors:
            last_color = sorted_lab_colors[-1]
            distances = [deltaE_ciede2000(last_color, lab_color) for lab_color in lab_colors]
            next_index = np.argmin(distances)
            next_color = lab_colors.pop(next_index)
            sorted_lab_colors.append(next_color)
        sorted_colors = [color.lab2rgb(np.array([[lab_col]]))[0][0] for lab_col in sorted_lab_colors]
        swatchsize = 3
        self.palette = Image.new('RGB', (swatchsize*num_colors, swatchsize))
        posx = 0
        for col in sorted_colors:
            col = tuple(map(lambda x: int(round(x * 255)), col))
            self.palette.paste(col, (posx, 0, posx+swatchsize, swatchsize))
            posx += swatchsize
        file_name = os.path.basename(self.file_path)
        file_name = os.path.splitext(file_name)[0] + "_color_palette.png"
        save_file_path = filedialog.asksaveasfilename(defaultextension=".png", initialfile=file_name)
        if save_file_path:
            self.palette.save(save_file_path)

    def decrease_scale(self, event):
        current_value = self.scale.get()
        new_value = max(current_value - 1, self.scale.cget("from"))
        self.scale.set(new_value)
        return "break"

    def increase_scale(self, event):
        current_value = self.scale.get()
        new_value = min(current_value + 1, self.scale.cget("to"))
        self.scale.set(new_value)
        return "break"

def main():
    root = tk.Tk()
    icon_data = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQBAMAAADt3eJSAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAeUExURRMDEB0FGCcHITwJIVILIH0PH6gUHdMYHP8lK////9UYX/kAAAABYktHRAnx2aXsAAAAB3RJTUUH5wQXAzoaJVbRJgAAAChJREFUCNdjYGBgFBQUUlJiIIZhbGzi4uIaGkoaIy0tvby8oqODGAYAKiohEXlZcJwAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjMtMDQtMjNUMDM6NTg6MjUrMDA6MDDuL0rHAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDIzLTA0LTIzVDAzOjU4OjI1KzAwOjAwn3LyewAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyMy0wNC0yM1QwMzo1ODoyNiswMDowMPmPyTkAAAAASUVORK5CYII="
    icon = tk.PhotoImage(data=icon_data)
    root.iconphoto(True, icon)
    app = Img2Palette(root)
    root.update_idletasks()
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    window_width = root.winfo_width()
    window_height = root.winfo_height()
    x = (screen_width // 2) - (window_width // 2)
    y = (screen_height // 2) - (window_height // 2)
    root.geometry(f'{window_width}x{window_height}+{x}+{y}')
    root.mainloop()

if __name__ == '__main__':
    main()