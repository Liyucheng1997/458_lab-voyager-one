"""旅行者一号 (Voyager 1) 程序化建模脚本 —— Blender 4.2+ / 5.x

用法（命令行，无界面）：
    blender -b -P blender/build_voyager1.py
会生成：
    blender/voyager1.blend        含两个场景：Voyager1（模型）和 Trajectory（真实轨迹动画）
    web/models/voyager1.glb       给网页用的模型
    blender/voyager1_preview.png  渲染预览图

尺寸以真实探测器为准（单位：米）：
    高增益天线 3.66 m；十边形主体 1.78 m；磁强计杆 13 m；射电/等离子波天线 2×10 m。
坐标：+Z 为高增益天线指向（对地）方向；导出 glTF 后为 +Y。
"""
import bpy, bmesh, json, math, os, sys, datetime
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GLB_PATH = os.path.join(ROOT, "web", "models", "voyager1.glb")
BLEND_PATH = os.path.join(HERE, "voyager1.blend")
PREVIEW_PATH = os.path.join(HERE, "voyager1_preview.png")
EPHEM_PATH = os.path.join(ROOT, "web", "data", "voyager1.json")
RENDER = "--no-render" not in sys.argv

# ---------------------------------------------------------------- 场景清理
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = "Voyager1"
scene.unit_settings.system = 'METRIC'

# ---------------------------------------------------------------- 材质
def make_mat(name, color, metallic=0.0, rough=0.5, emission=None, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.use_backface_culling = False
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1)
        b.inputs["Emission Strength"].default_value = 3.0
    if coat and "Coat Weight" in b.inputs:
        b.inputs["Coat Weight"].default_value = coat
    m.diffuse_color = (*color, 1)
    return m

MAT = {
    "dish":   make_mat("HGA_White",     (0.86, 0.86, 0.83), 0.0, 0.55),
    "dishbk": make_mat("HGA_Back",      (0.62, 0.62, 0.60), 0.2, 0.5),
    "mli":    make_mat("MLI_Black",     (0.025, 0.025, 0.03), 0.4, 0.38),
    "kapton": make_mat("MLI_Kapton",    (0.78, 0.50, 0.16), 1.0, 0.32),
    "alu":    make_mat("Aluminum",      (0.80, 0.80, 0.82), 1.0, 0.30),
    "frame":  make_mat("Frame_Grey",    (0.45, 0.45, 0.47), 0.7, 0.40),
    "rtg":    make_mat("RTG_Dark",      (0.10, 0.10, 0.11), 0.6, 0.45),
    "boom":   make_mat("Boom_White",    (0.82, 0.82, 0.76), 0.0, 0.50),
    "gold":   make_mat("Golden_Record", (1.00, 0.72, 0.30), 1.0, 0.18),
    "lens":   make_mat("Lens_Black",    (0.01, 0.01, 0.015), 0.0, 0.05, coat=1.0),
    "louver": make_mat("Louver_Silver", (0.92, 0.92, 0.94), 1.0, 0.12),
}

# ---------------------------------------------------------------- 几何构建器
def basis(axis):
    """给定轴向，返回与之正交的两个单位向量。"""
    a = Vector(axis).normalized()
    ref = Vector((0, 0, 1)) if abs(a.z) < 0.9 else Vector((1, 0, 0))
    u = a.cross(ref).normalized()
    v = a.cross(u).normalized()
    return a, u, v


class Part:
    """一个部件 = 一个 Blender 物体，可包含多种材质。"""

    def __init__(self, name, desc=""):
        self.name, self.desc = name, desc
        self.bm = bmesh.new()
        self.mats = []

    def mi(self, key):
        m = MAT[key]
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def _face(self, verts, mat, smooth):
        f = self.bm.faces.new(verts)
        f.material_index = self.mi(mat)
        f.smooth = smooth
        return f

    # 圆台/圆柱/圆锥：p0 → p1
    def frustum(self, p0, p1, r0, r1, mat, seg=20, cap0=True, cap1=True, smooth=True):
        p0, p1 = Vector(p0), Vector(p1)
        a, u, v = basis(p1 - p0)
        ring0, ring1 = [], []
        for i in range(seg):
            t = 2 * math.pi * i / seg
            d = u * math.cos(t) + v * math.sin(t)
            ring0.append(self.bm.verts.new(p0 + d * r0))
            ring1.append(self.bm.verts.new(p1 + d * r1))
        for i in range(seg):
            j = (i + 1) % seg
            self._face([ring0[i], ring0[j], ring1[j], ring1[i]], mat, smooth)
        for cap, rad, ctr, rev in ((cap0, r0, p0, True), (cap1, r1, p1, False)):
            if cap and rad > 1e-5:
                ring = [self.bm.verts.new(ctr + (u * math.cos(2 * math.pi * i / seg) + v * math.sin(2 * math.pi * i / seg)) * rad) for i in range(seg)]
                self._face(ring[::-1] if rev else ring, mat, False)

    def tube(self, p0, p1, r, mat, seg=8, caps=True):
        self.frustum(p0, p1, r, r, mat, seg, caps, caps)

    def cyl(self, center, axis, r, length, mat, seg=24, caps=True):
        c, a = Vector(center), Vector(axis).normalized()
        self.frustum(c - a * length / 2, c + a * length / 2, r, r, mat, seg, caps, caps)

    def box(self, center, size, mat, rot=None):
        c = Vector(center)
        sx, sy, sz = (s / 2 for s in size)
        R = rot.to_3x3() if rot is not None else Matrix.Identity(3)
        corners = [Vector((x, y, z)) for x in (-sx, sx) for y in (-sy, sy) for z in (-sz, sz)]
        vs = [self.bm.verts.new(c + R @ p) for p in corners]
        for idx in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self._face([vs[i] for i in idx], mat, False)

    def sphere(self, center, r, mat, seg=24, rings=12):
        c = Vector(center)
        top = self.bm.verts.new(c + Vector((0, 0, r)))
        bot = self.bm.verts.new(c - Vector((0, 0, r)))
        grid = []
        for j in range(1, rings):
            th = math.pi * j / rings
            grid.append([self.bm.verts.new(c + Vector((math.sin(th) * math.cos(2 * math.pi * i / seg),
                                                        math.sin(th) * math.sin(2 * math.pi * i / seg),
                                                        math.cos(th))) * r) for i in range(seg)])
        for i in range(seg):
            j = (i + 1) % seg
            self._face([top, grid[0][i], grid[0][j]], mat, True)
            self._face([bot, grid[-1][j], grid[-1][i]], mat, True)
            for k in range(len(grid) - 1):
                self._face([grid[k][i], grid[k + 1][i], grid[k + 1][j], grid[k][j]], mat, True)

    def prism(self, center, n, r, h, mat, rot_offset=0.0):
        """正 n 棱柱（Z 向），平侧面。"""
        c = Vector(center)
        bot, top = [], []
        for i in range(n):
            t = 2 * math.pi * i / n + rot_offset
            d = Vector((math.cos(t), math.sin(t), 0)) * r
            bot.append(self.bm.verts.new(c + d - Vector((0, 0, h / 2))))
            top.append(self.bm.verts.new(c + d + Vector((0, 0, h / 2))))
        for i in range(n):
            j = (i + 1) % n
            self._face([bot[i], bot[j], top[j], top[i]], mat, False)
        self._face(top, mat, False)
        self._face(bot[::-1], mat, False)

    def paraboloid_dish(self, R, depth, thick, z0, mat_front, mat_back, seg=72, rings=14):
        """抛物面天线：顶点在 z0，口径 R，深 depth，带厚度和背面。"""
        f = R * R / (4 * depth)
        def ring(r, off):
            z = z0 + r * r / (4 * f) + off
            return [self.bm.verts.new((r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg), z)) for i in range(seg)]
        r_in = 0.08
        front = [ring(r_in + (R - r_in) * k / rings, 0) for k in range(rings + 1)]
        back = [ring(r_in + (R - r_in) * k / rings, -thick) for k in range(rings + 1)]
        for k in range(rings):
            for i in range(seg):
                j = (i + 1) % seg
                self._face([front[k][i], front[k][j], front[k + 1][j], front[k + 1][i]], mat_front, True)
                self._face([back[k][i], back[k + 1][i], back[k + 1][j], back[k][j]], mat_back, True)
        for i in range(seg):  # 外缘 + 内孔
            j = (i + 1) % seg
            self._face([front[-1][i], front[-1][j], back[-1][j], back[-1][i]], mat_back, False)
            self._face([front[0][j], front[0][i], back[0][i], back[0][j]], mat_back, False)
        return f

    def build(self, parent=None, collection=None):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        ob = bpy.data.objects.new(self.name, me)
        (collection or scene.collection).objects.link(ob)
        if parent:
            ob.parent = parent
        ob["desc"] = self.desc
        return ob


# ---------------------------------------------------------------- 模型
col = bpy.data.collections.new("Voyager1_Model")
scene.collection.children.link(col)
root = bpy.data.objects.new("Voyager1", None)
root.empty_display_type = 'ARROWS'
col.objects.link(root)

BUS_R = 0.94          # 十边形外接圆半径
BUS_H = 0.47
BUS_TOP = 0.0
BUS_C = Vector((0, 0, BUS_TOP - BUS_H / 2))
TEN = 2 * math.pi / 10

def bus_face(k, z=None, out=0.0):
    """第 k 个侧面中心点与外法线。"""
    t = TEN * (k + 0.5)
    n = Vector((math.cos(t), math.sin(t), 0))
    apo = BUS_R * math.cos(TEN / 2)
    return Vector((n.x * (apo + out), n.y * (apo + out), BUS_C.z if z is None else z)), n

# --- 主体：十边形电子舱 + 推进模块
bus = Part("Bus", "十边形主体：10 个电子设备舱，内含球形肼燃料箱、计算机与发射机")
bus.prism(BUS_C, 10, BUS_R, BUS_H, "mli")
for k in range(10):  # 各舱位的面板、热控百叶窗
    c, n = bus_face(k, out=0.012)
    a, u, v = basis(n)
    rot = Matrix((u, v, a)).transposed().to_4x4()
    if k in (2, 3, 7):
        bus.box(c, (0.42, 0.30, 0.02), "louver", rot)
        for s in range(-3, 4):  # 百叶片
            bus.box(c + Vector((0, 0, s * 0.04)) + n * 0.014, (0.40, 0.01, 0.012), "frame",
                    Matrix((n.cross(Vector((0, 0, 1))).normalized(), n, Vector((0, 0, 1)))).transposed().to_4x4())
    else:
        bus.box(c, (0.46, 0.36, 0.015), "mli", rot)
bus.cyl(BUS_C + Vector((0, 0, BUS_H / 2 + 0.03)), (0, 0, 1), 0.55, 0.06, "frame", 30)   # 天线安装环
bus.frustum(BUS_C - Vector((0, 0, BUS_H / 2)), BUS_C - Vector((0, 0, BUS_H / 2 + 0.30)), 0.55, 0.42, "kapton", 30)  # 推进模块
bus.cyl(BUS_C - Vector((0, 0, BUS_H / 2 + 0.36)), (0, 0, 1), 0.30, 0.12, "frame", 24)
for k in range(4):  # 姿控推力器喷口
    t = math.pi / 4 + k * math.pi / 2
    p = BUS_C - Vector((0, 0, BUS_H / 2 + 0.40)) + Vector((math.cos(t), math.sin(t), 0)) * 0.22
    bus.frustum(p, p - Vector((0, 0, 0.10)), 0.025, 0.05, "alu", 12, True, False)
bus_ob = bus.build(root, col)

# --- 高增益天线（3.66 m 卡塞格伦）
hga = Part("HGA", "高增益天线：口径 3.66 m，S/X 波段，至今仍以 160 bit/s 向地球回传数据")
Z0 = BUS_TOP + 0.10
R = 1.83
DEPTH = 0.48
f = hga.paraboloid_dish(R, DEPTH, 0.03, Z0, "dish", "dishbk")
rim_z = Z0 + DEPTH
# 背部桁架：放射状加强筋 + 中心锥
for k in range(12):
    t = 2 * math.pi * k / 12
    d = Vector((math.cos(t), math.sin(t), 0))
    hga.tube(Vector((0, 0, Z0 - 0.04)) + d * 0.4, d * 1.5 + Vector((0, 0, Z0 + 1.5 ** 2 / (4 * f) - 0.05)), 0.015, "frame", 6)
hga.frustum((0, 0, BUS_TOP), (0, 0, Z0 + 0.05), 0.5, 0.35, "frame", 24)
# 馈源喇叭 + 副反射面 + 三脚支撑
focus_z = Z0 + f
sub_z = Z0 + 0.95
hga.frustum((0, 0, Z0 + 0.02), (0, 0, Z0 + 0.42), 0.09, 0.15, "alu", 20, True, False)
hga.frustum((0, 0, sub_z), (0, 0, sub_z + 0.09), 0.26, 0.05, "alu", 32)
for k in range(3):
    t = 2 * math.pi * k / 3 + math.pi / 6
    d = Vector((math.cos(t), math.sin(t), 0))
    base = d * 1.15 + Vector((0, 0, Z0 + 1.15 ** 2 / (4 * f) + 0.02))
    hga.tube(base, Vector((0, 0, sub_z + 0.02)) + d * 0.22, 0.016, "boom", 8)
# 低增益天线（副反射面背后）
hga.frustum((0, 0, sub_z + 0.09), (0, 0, sub_z + 0.22), 0.06, 0.10, "alu", 16)
# 太阳敏感器
hga.box((0, R - 0.08, rim_z + 0.04), (0.10, 0.10, 0.08), "mli")
hga.cyl((0, R - 0.08, rim_z + 0.10), (0, 0, 1), 0.03, 0.04, "lens", 12)
hga.build(root, col)

# --- 金唱片（安装在主体侧面）
gr = Part("Golden_Record", "金唱片：收录 55 种语言的问候、115 幅图像与 90 分钟音乐，写给可能的外星文明")
c, n = bus_face(5, z=BUS_C.z, out=0.03)
gr.cyl(c, n, 0.165, 0.012, "gold", 48)
gr.cyl(c + n * 0.008, n, 0.03, 0.006, "frame", 16)
for k in range(4):  # 安装支架
    t = math.pi / 4 + k * math.pi / 2
    _, u, v = basis(n)
    p = c + (u * math.cos(t) + v * math.sin(t)) * 0.19
    gr.box(p - n * 0.01, (0.04, 0.04, 0.04), "alu", Matrix((u, v, n)).transposed().to_4x4())
gr.build(root, col)

# --- RTG 杆 + 3 台放射性同位素温差发电机
RTG_DIR = Vector((math.cos(math.radians(-30)), math.sin(math.radians(-30)), -0.08)).normalized()
rb = Part("RTG_Boom", "RTG 支撑杆：把核电源放到远离科学仪器的位置，减少辐射干扰")
start = Vector((0, 0, BUS_C.z)) + Vector((RTG_DIR.x, RTG_DIR.y, 0)).normalized() * 0.85
end = start + RTG_DIR * 2.55
a, u, v = basis(RTG_DIR)
for k in range(3):  # 三角桁架
    t = 2 * math.pi * k / 3
    off = (u * math.cos(t) + v * math.sin(t)) * 0.07
    rb.tube(start + off, end + off, 0.012, "frame", 6)
for s in range(9):
    p = start + RTG_DIR * (2.55 * s / 8)
    pts = [p + (u * math.cos(2 * math.pi * k / 3) + v * math.sin(2 * math.pi * k / 3)) * 0.07 for k in range(3)]
    for k in range(3):
        rb.tube(pts[k], pts[(k + 1) % 3], 0.008, "frame", 5, False)
rb.build(root, col)

for i in range(3):
    rtg = Part(f"RTG_{i + 1}", "MHW-RTG 核电源：钚-238 衰变发热，热电偶发电。发射时 3 台共约 470 W，每年减少约 4 W")
    c = start + RTG_DIR * (0.75 + i * 0.70)
    rtg.cyl(c, RTG_DIR, 0.12, 0.58, "rtg", 28)
    rtg.cyl(c, RTG_DIR, 0.135, 0.04, "frame", 28)
    for e in (-1, 1):
        rtg.cyl(c + RTG_DIR * e * 0.30, RTG_DIR, 0.10, 0.04, "frame", 24)
    for k in range(8):  # 散热翅片
        t = 2 * math.pi * k / 8 + math.pi / 8
        d = u * math.cos(t) + v * math.sin(t)
        side = d.cross(RTG_DIR).normalized()
        rot = Matrix((RTG_DIR, d, side)).transposed().to_4x4()
        rtg.box(c + d * 0.19, (0.56, 0.15, 0.008), "rtg", rot)
    rtg.build(root, col)

# --- 科学仪器杆 + 扫描平台
SCI_DIR = Vector((math.cos(math.radians(150)), math.sin(math.radians(150)), 0.02)).normalized()
sb = Part("Science_Boom", "科学仪器杆：宇宙线(CRS)、低能带电粒子(LECP)、等离子体(PLS)仪器")
s0 = Vector((0, 0, BUS_C.z + 0.05)) + Vector((SCI_DIR.x, SCI_DIR.y, 0)).normalized() * 0.85
s1 = s0 + SCI_DIR * 2.2
a, u, v = basis(SCI_DIR)
for k in range(4):
    t = 2 * math.pi * k / 4 + math.pi / 4
    off = (u * math.cos(t) + v * math.sin(t)) * 0.08
    sb.tube(s0 + off, s1 + off, 0.013, "frame", 6)
for s in range(8):
    p = s0 + SCI_DIR * (2.2 * s / 7)
    pts = [p + (u * math.cos(2 * math.pi * k / 4 + math.pi / 4) + v * math.sin(2 * math.pi * k / 4 + math.pi / 4)) * 0.08 for k in range(4)]
    for k in range(4):
        sb.tube(pts[k], pts[(k + 1) % 4], 0.008, "frame", 5, False)
up = Vector((0, 0, 1))
# CRS 宇宙线仪器（箱体 + 望远镜筒）
crs = s0 + SCI_DIR * 0.55 + up * 0.2
sb.box(crs, (0.32, 0.32, 0.22), "kapton")
for k in range(3):
    sb.cyl(crs + up * 0.13 + u * (k - 1) * 0.09, up, 0.035, 0.08, "alu", 12)
# PLS 等离子体仪器（四个法拉第杯）
pls = s0 + SCI_DIR * 0.95 - up * 0.16
sb.box(pls, (0.22, 0.22, 0.14), "mli")
for k in range(4):
    t = math.pi / 2 * k
    d = u * math.cos(t) + v * math.sin(t)
    sb.frustum(pls + d * 0.1, pls + d * 0.18 + up * 0.04, 0.04, 0.06, "alu", 14, True, False)
# LECP 低能带电粒子（带步进电机的圆筒）
lecp = s0 + SCI_DIR * 1.45 + up * 0.18
sb.cyl(lecp, SCI_DIR, 0.12, 0.25, "kapton", 24)
sb.cyl(lecp + up * 0.15, up, 0.06, 0.12, "alu", 16)
sb.build(root, col)

sp = Part("Scan_Platform", "扫描平台：窄角/广角相机(ISS)、红外光谱仪(IRIS)、紫外光谱仪(UVS)、光偏振计(PPS)")
pc = s1 + SCI_DIR * 0.25
sp.cyl(pc, SCI_DIR, 0.16, 0.18, "frame", 24)       # 方位/俯仰驱动
plat = pc + SCI_DIR * 0.25
sp.box(plat, (0.55, 0.65, 0.10), "mli", Matrix((SCI_DIR, u, v)).transposed().to_4x4())
LOOK = -v if (-v).z < 0 else v   # 仪器视线：朝侧下方
LOOK = (LOOK + Vector((0, 0, -0.3))).normalized()
side = SCI_DIR.cross(LOOK).normalized()
# IRIS 红外干涉光谱仪：0.5 m 卡塞格伦望远镜
iris = plat + side * 0.10 + LOOK * 0.30
sp.cyl(iris, LOOK, 0.26, 0.46, "kapton", 32)
sp.frustum(iris + LOOK * 0.23, iris + LOOK * 0.30, 0.26, 0.28, "alu", 32, False, False)
sp.cyl(iris + LOOK * 0.22, LOOK, 0.22, 0.01, "lens", 32)
# ISS 窄角相机（长筒）+ 广角相机
na = plat - side * 0.22 + SCI_DIR * 0.10 + LOOK * 0.35
sp.cyl(na, LOOK, 0.09, 0.95, "mli", 20)
sp.cyl(na + LOOK * 0.47, LOOK, 0.07, 0.01, "lens", 20)
wa = plat - side * 0.22 - SCI_DIR * 0.14 + LOOK * 0.20
sp.cyl(wa, LOOK, 0.07, 0.55, "mli", 20)
sp.cyl(wa + LOOK * 0.28, LOOK, 0.05, 0.01, "lens", 20)
# UVS 紫外光谱仪 + PPS 光偏振计
sp.box(plat + side * 0.30 - SCI_DIR * 0.18 + LOOK * 0.12, (0.30, 0.14, 0.14), "kapton", Matrix((LOOK, side, SCI_DIR)).transposed().to_4x4())
pps = plat + side * 0.32 + SCI_DIR * 0.16 + LOOK * 0.16
sp.cyl(pps, LOOK, 0.06, 0.32, "alu", 16)
sp.build(root, col)

# --- 磁强计杆：13 m 玻璃纤维伸展桁架（Astromast）
MAG_DIR = Vector((math.cos(math.radians(95)), math.sin(math.radians(95)), 0.05)).normalized()
mb = Part("MAG_Boom", "磁强计杆：13 m 长的可伸展桁架，把磁强计远离主体自身磁场")
m0 = Vector((0, 0, BUS_C.z - 0.05)) + Vector((MAG_DIR.x, MAG_DIR.y, 0)).normalized() * 0.92
mb.cyl(m0 + MAG_DIR * 0.25, MAG_DIR, 0.17, 0.55, "kapton", 24)   # 收纳筒
a, u, v = basis(MAG_DIR)
L, W, N = 12.4, 0.11, 40
mstart = m0 + MAG_DIR * 0.5
def lon(k, s):
    t = 2 * math.pi * k / 3 + s * 0.0  # 不扭转
    return mstart + MAG_DIR * s + (u * math.cos(t) + v * math.sin(t)) * W
for k in range(3):
    mb.tube(lon(k, 0), lon(k, L), 0.006, "boom", 5)
for i in range(N):
    s0_, s1_ = L * i / N, L * (i + 1) / N
    for k in range(3):
        mb.tube(lon(k, s0_), lon((k + 1) % 3, s0_), 0.004, "boom", 4, False)
        mb.tube(lon(k, s0_), lon((k + 1) % 3, s1_), 0.003, "boom", 4, False)
for s in (L * 0.47, L):   # 低场磁强计探头（中段与末端）
    p = mstart + MAG_DIR * s
    mb.cyl(p, MAG_DIR, 0.09, 0.22, "kapton", 20)
mb.build(root, col)

# --- 行星射电 / 等离子波天线（两根 10 m 鞭状天线，呈 V 形）
pra = Part("PRA_PWS_Antennas", "行星射电天文(PRA)与等离子波(PWS)天线：两根 10 m 鞭状天线，2012 年正是它“听到”了星际等离子体")
base = Vector((0, 0, BUS_C.z - 0.1)) + Vector((math.cos(math.radians(225)), math.sin(math.radians(225)), 0)) * 0.85
pra.box(base, (0.18, 0.18, 0.12), "mli")
mid = Vector((math.cos(math.radians(225)), math.sin(math.radians(225)), 0))
perp = Vector((-mid.y, mid.x, 0))
for sgn in (-1, 1):
    d = (mid * 0.55 + perp * sgn * 0.70 + Vector((0, 0, -0.45))).normalized()
    pra.tube(base, base + d * 10.0, 0.009, "alu", 6)
pra.build(root, col)

# ---------------------------------------------------------------- 灯光与相机（预览渲染）
def add_light(name, kind, energy, loc, rot, color=(1, 1, 1), size=None):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy
    ld.color = color
    if size is not None and hasattr(ld, "angle"):
        ld.angle = size
    lo = bpy.data.objects.new(name, ld)
    lo.location = loc
    lo.rotation_euler = rot
    scene.collection.objects.link(lo)
    return lo

add_light("Sun_Key", 'SUN', 4.5, (10, -10, 10), (math.radians(50), 0, math.radians(35)), (1, 0.97, 0.92), 0.01)
add_light("Fill", 'SUN', 0.5, (-10, 10, 0), (math.radians(110), 0, math.radians(220)), (0.6, 0.7, 1.0))
add_light("Rim", 'SUN', 2.0, (0, 10, -5), (math.radians(-60), 0, math.radians(180)), (0.8, 0.85, 1.0))

world = bpy.data.worlds.new("Space")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.004, 0.005, 0.008, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
scene.world = world

cam_d = bpy.data.cameras.new("Cam")
cam_d.lens = 32
cam = bpy.data.objects.new("Camera", cam_d)
scene.collection.objects.link(cam)
az, el, dist = math.radians(-115), math.radians(16), 15.5
target = Vector((-0.4, 1.6, -0.2))
cam.location = target + Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el))) * dist
cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera = cam

# ---------------------------------------------------------------- 导出 GLB
os.makedirs(os.path.dirname(GLB_PATH), exist_ok=True)
for ob in bpy.data.objects:
    ob.select_set(ob.name in col.all_objects)
bpy.context.view_layer.objects.active = root
bpy.ops.export_scene.gltf(filepath=GLB_PATH, export_format='GLB', use_selection=True,
                          export_apply=True, export_yup=True, export_extras=True,
                          export_lights=False, export_cameras=False)
print("GLB ->", GLB_PATH)

# ---------------------------------------------------------------- 第二个场景：真实轨迹（拖动时间轴即可看探测器移动）
def build_trajectory_scene():
    if not os.path.exists(EPHEM_PATH):
        print("没有星历数据，跳过轨迹场景")
        return
    data = json.load(open(EPHEM_PATH, encoding="utf-8"))
    rows = data["rows"]
    ts = bpy.data.scenes.new("Trajectory")
    ts.world = world
    tcol = bpy.data.collections.new("Trajectory")
    ts.collection.children.link(tcol)

    # 轨迹曲线（1 BU = 1 AU）
    cu = bpy.data.curves.new("Voyager1_Path", 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = 0.06
    sp_ = cu.splines.new('POLY')
    pts = rows[::2]
    sp_.points.add(len(pts) - 1)
    for p, r in zip(sp_.points, pts):
        p.co = (r[1], r[2], r[3], 1)
    path = bpy.data.objects.new("Voyager1_Path", cu)
    path.data.materials.append(make_mat("Path_Blue", (0.04, 0.52, 1.0), 0, 0.4, emission=(0.04, 0.52, 1.0)))
    tcol.objects.link(path)

    # 太阳 + 行星轨道（圆近似，仅作参照）
    sun_ob = bpy.data.objects.new("Sun", bpy.data.meshes.new("SunMesh"))
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=1.2); bm.to_mesh(sun_ob.data); bm.free()
    sun_ob.data.materials.append(make_mat("Sun_Glow", (1, 0.8, 0.4), emission=(1, 0.75, 0.3)))
    tcol.objects.link(sun_ob)
    for name, a_ in (("Earth", 1.0), ("Mars", 1.524), ("Jupiter", 5.203), ("Saturn", 9.537), ("Uranus", 19.19), ("Neptune", 30.07)):
        c = bpy.data.curves.new(name + "_Orbit", 'CURVE'); c.dimensions = '3D'; c.bevel_depth = 0.03
        s = c.splines.new('POLY'); s.points.add(127); s.use_cyclic_u = True
        for i, p in enumerate(s.points):
            t = 2 * math.pi * i / 128
            p.co = (a_ * math.cos(t), a_ * math.sin(t), 0, 1)
        o = bpy.data.objects.new(name + "_Orbit", c)
        o.data.materials.append(MAT["frame"])
        tcol.objects.link(o)

    # 探测器：放大的模型实例，逐帧关键帧（1 帧 = 30 天）
    probe = bpy.data.objects.new("Voyager1_Probe", None)
    probe.instance_type = 'COLLECTION'
    probe.instance_collection = col
    probe.scale = (0.6, 0.6, 0.6)
    tcol.objects.link(probe)
    jd0, jd1 = rows[0][0], rows[-1][0]
    step = 30.0
    nframes = int((jd1 - jd0) / step)
    import bisect
    jds = [r[0] for r in rows]
    def pos(jd):
        i = max(1, min(len(rows) - 1, bisect.bisect_left(jds, jd)))
        a_, b_ = rows[i - 1], rows[i]
        w = (jd - a_[0]) / (b_[0] - a_[0])
        return [a_[k] + (b_[k] - a_[k]) * w for k in (1, 2, 3)]
    probe.animation_data_create()
    act = bpy.data.actions.new("Voyager1_Flight")
    probe.animation_data.action = act
    try:
        fcs = [act.fcurves.new("location", index=k) for k in range(3)]
    except AttributeError:   # Blender 5.x：分层动作
        for f_ in range(0, nframes + 1, 1):
            probe.location = pos(jd0 + f_ * step)
            probe.keyframe_insert("location", frame=f_ + 1)
        fcs = None
    if fcs:
        for k, fc in enumerate(fcs):
            fc.keyframe_points.add(nframes + 1)
            for f_ in range(nframes + 1):
                kp = fc.keyframe_points[f_]
                kp.co = (f_ + 1, pos(jd0 + f_ * step)[k])
                kp.interpolation = 'LINEAR'
    ts.frame_start, ts.frame_end = 1, nframes + 1
    ts.render.fps = 24
    ts["jd0"], ts["days_per_frame"] = jd0, step

    # 信息文字 + 帧变化回调（脚本已注册：打开 .blend 时允许运行脚本即可）
    txt = bpy.data.curves.new("Info", 'FONT')
    txt.body = "Voyager 1"
    txt.size = 3.0
    info = bpy.data.objects.new("Info", txt)
    info.location = (-60, 40, 0)
    info.data.materials.append(make_mat("Text_White", (1, 1, 1), emission=(1, 1, 1)))
    tcol.objects.link(info)
    handler = bpy.data.texts.new("voyager_info_handler.py")
    handler.use_module = True
    handler.write('''import bpy, math, datetime
def _vg_update(scene, *args):
    if scene.name != "Trajectory" or "Info" not in scene.objects:
        return
    pr = scene.objects.get("Voyager1_Probe")
    jd = scene["jd0"] + (scene.frame_current - 1) * scene["days_per_frame"]
    d = datetime.datetime(2000, 1, 1, 12) + datetime.timedelta(days=jd - 2451545.0)
    r = pr.matrix_world.translation.length
    scene.objects["Info"].data.body = "Voyager 1  %s\\n%.2f AU  |  %.2f billion km  |  light %.1f h" % (
        d.strftime("%Y-%m-%d"), r, r * 0.1495978707, r * 149597870.7 / 299792.458 / 3600)
bpy.app.handlers.frame_change_post[:] = [h for h in bpy.app.handlers.frame_change_post if h.__name__ != "_vg_update"]
bpy.app.handlers.frame_change_post.append(_vg_update)
''')
    cam2 = bpy.data.objects.new("TopCam", bpy.data.cameras.new("TopCam"))
    cam2.location = (-20, -40, 260)
    cam2.rotation_euler = (math.radians(8), 0, 0)
    tcol.objects.link(cam2)
    ts.camera = cam2
    print("轨迹场景：", nframes + 1, "帧")

build_trajectory_scene()

# ---------------------------------------------------------------- 渲染预览 & 保存
if RENDER:
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1000
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'AgX' if 'AgX' in [i.identifier for i in scene.view_settings.bl_rna.properties['view_transform'].enum_items] else 'Filmic'
    scene.render.filepath = PREVIEW_PATH
    bpy.ops.render.render(write_still=True, scene=scene.name)
    print("Preview ->", PREVIEW_PATH)

bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
print("Blend ->", BLEND_PATH)
