# The icon, a gold ring as a magnifier, rendered with Blender's Cycles:
#   blender -b --factory-startup -P icons/ring.py -- <folder>
# icons/build.sh makes the icon files and the store's small tile of the renders.
import bpy, math, random, sys, mathutils
out=sys.argv[sys.argv.index('--')+1]
def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)
def mat(name,color,metal=1.0,rough=.16,emit=None,strength=0):
    m=bpy.data.materials.new(name); m.use_nodes=True; b=m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value=(*color,1); b.inputs['Metallic'].default_value=metal; b.inputs['Roughness'].default_value=rough
    if emit: b.inputs['Emission Color'].default_value=(*emit,1); b.inputs['Emission Strength'].default_value=strength
    return m
def lathe(profile,n=256):
    verts=[];faces=[];k=len(profile)
    for i in range(n):
        a=2*math.pi*i/n
        for r,z in profile: verts.append((r*math.cos(a),r*math.sin(a),z))
    for i in range(n):
        for j in range(k):
            faces.append((i*k+j,((i+1)%n)*k+j,((i+1)%n)*k+(j+1)%k,i*k+(j+1)%k))
    me=bpy.data.meshes.new('ring');me.from_pydata(verts,[],faces);me.update()
    o=bpy.data.objects.new('ring',me);bpy.context.collection.objects.link(o)
    for p in me.polygons:p.use_smooth=True
    return o
def band(w,t,R=1.0,n=64):
    # domed outside, gently curved inside
    pr=[]
    for i in range(n):
        a=2*math.pi*i/n; e=.62
        c,s=math.cos(a),math.sin(a)
        pr.append((R+t/2*math.copysign(abs(c)**e,c),w/2*math.copysign(abs(s)**e,s)))
    return lathe(pr)
def cyl(p,q,r,m,taper=1.0):
    d=mathutils.Vector(q)-mathutils.Vector(p)
    bpy.ops.mesh.primitive_cone_add(vertices=96,radius1=r,radius2=r*taper,depth=d.length,location=(mathutils.Vector(p)+mathutils.Vector(q))/2)
    o=bpy.context.object;o.rotation_euler=d.to_track_quat('Z','Y').to_euler();o.data.materials.append(m)
    bv=o.modifiers.new('b','BEVEL');bv.width=r*.45;bv.segments=6;bv.limit_method='ANGLE'
    bpy.ops.object.shade_smooth();return o
def sphere(p,r,m):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64,ring_count=28,radius=r,location=p);o=bpy.context.object;o.data.materials.append(m);bpy.ops.object.shade_smooth();return o
def marks(w,t,m,burnt,count=28,seed=7,inner=False):
    # a flowing line of made-up letters: stems, bows and loops on a common line
    random.seed(seed);objs=[];e=.62
    def radius(z):
        zz=min(1,abs(z)/(w/2)); s_=zz**(1/e); c_=max(0,1-s_*s_)**.5
        return 1+(t/2*c_**e+.002)*(-1 if inner else 1)
    for k in range(count):
        a0=2*math.pi*k/count; h=w*.31; kind=random.choice([0,0,1,2,3,4]); strokes=[]
        S=[i/20 for i in range(21)]
        strokes.append([(-.98+1.96*x,-.35) for x in S])      # base line
        if kind==0: strokes.append([(-.3+.12*x,.95-1.3*x) for x in S]); strokes.append([(-.3+.62*math.sin(x*math.pi),.35-.7*x) for x in S])
        if kind==1: strokes.append([(.1,-.3-.7*x) for x in S]); strokes.append([(.1-.6*math.sin(x*math.pi),-.3+.75*x) for x in S])
        if kind==2: strokes.append([(.45*math.cos(x*6.28),.1+.42*math.sin(x*6.28)) for x in S])
        if kind==3: strokes.append([(-.45+.9*x,.35+.45*math.sin(x*math.pi)) for x in S])
        if kind==4: strokes.append([(.25*math.sin(x*6.28),.9-1.25*x) for x in S])
        for pts in strokes:
          for mm,wd,lift in ((burnt,.034,-.013),(m,.0165,.0)):
            cu=bpy.data.curves.new('m','CURVE');cu.dimensions='3D';cu.bevel_depth=w*wd;cu.bevel_resolution=3;cu.use_fill_caps=True
            sp=cu.splines.new('POLY');sp.points.add(len(pts)-1)
            for q,(x,y) in zip(sp.points,pts):
                a=a0+x*(2*math.pi/count)*.52; R=radius(y*h)+lift*(-1 if inner else 1); q.co=(R*math.cos(a),R*math.sin(a),y*h,1)
            o=bpy.data.objects.new('m',cu);cu.materials.append(mm);bpy.context.collection.objects.link(o);objs.append(o)
    return objs
def area(loc,size,power,color=(1,1,1),target=(0,0,0)):
    l=bpy.data.lights.new('a','AREA');l.energy=power;l.size=size;l.color=color
    o=bpy.data.objects.new('a',l);o.location=loc;o.rotation_euler=(mathutils.Vector(target)-mathutils.Vector(loc)).to_track_quat('-Z','Y').to_euler();bpy.context.collection.objects.link(o)
def scene(name,w,t,tilt,spin,handle,fire,rough=.15,hl=1.2,hr=.25,style='taper'):
    clear();sc=bpy.context.scene
    gold=mat('gold',(1.0,.62,.17),1,rough); dark=mat('dark',(.006,.005,.005),0,.1)
    glow=mat('glow',(.0,.0,.0),0,.5,(1,.15,.012),1.75)
    burnt=mat('burnt',(.07,.014,.003),.2,.6)
    ring=band(w,t);ring.data.materials.append(gold)
    parts=[ring]+(marks(w,t,glow,burnt)+marks(w,t,glow,burnt,inner=True,seed=3) if fire else [])
    e=bpy.data.objects.new('e',None);bpy.context.collection.objects.link(e)
    for p in parts:p.parent=e
    # The handle lies in the plane of the lens and runs out from the middle of
    # the band; ring and handle are one object, tilted together.
    d=mathutils.Vector((math.cos(-math.pi/4),math.sin(-math.pi/4),0))
    before=set(bpy.context.scene.objects)
    if handle!='none':
        hm={'gold':gold,'dark':dark}[handle]
        p0=d*(1+t/2)
        cyl(p0-d*t*.35,p0+d*.2,hr*1.05,gold,.85)
        a=p0+d*.12;b=a+d*hl
        if style=='taper':
            # slim at the ring, widening towards a flat end
            cyl(a+d*.04,a+d*.13,hr*1.12,gold)
            cyl(a+d*.1,b,hr*.72,hm,1.5); cyl(b-d*.1,b,hr*1.12,gold,1.03); cyl(b-d*.01,b+d*.035,hr*.98,mat('cap',(1.0,.66,.22),1,.48),.9)
    bpy.context.view_layer.update()
    for o in set(bpy.context.scene.objects)-before:
        if o.parent is None: o.parent=e
    ax=mathutils.Vector((math.cos(math.radians(spin)),math.sin(math.radians(spin)),0))
    e.rotation_mode='QUATERNION';e.rotation_quaternion=mathutils.Quaternion(ax,math.radians(tilt))
    wld=bpy.data.worlds.new('w');sc.world=wld;wld.use_nodes=True;nt=wld.node_tree;bg=nt.nodes['Background'];tc=nt.nodes.new('ShaderNodeTexCoord');sp=nt.nodes.new('ShaderNodeSeparateXYZ');rp=nt.nodes.new('ShaderNodeValToRGB');mp=nt.nodes.new('ShaderNodeMapRange')
    mp.inputs['From Min'].default_value=-1;mp.inputs['From Max'].default_value=1
    nt.links.new(tc.outputs['Generated'],sp.inputs[0]);nt.links.new(sp.outputs['Y'],mp.inputs['Value']);nt.links.new(mp.outputs['Result'],rp.inputs[0]);nt.links.new(rp.outputs[0],bg.inputs[0])
    cr=rp.color_ramp;cr.elements[0].position=.12;cr.elements[0].color=(.03,.012,.004,1);cr.elements[1].position=.95;cr.elements[1].color=(.75,.68,.55,1);el=cr.elements.new(.5);el.color=(.16,.09,.04,1);bg.inputs[1].default_value=1
    area((-3.5,3.5,4.5),3.4,900,(1,.96,.9));area((4.5,3,2.5),2.4,520,(1,.9,.72));area((0,-4.5,3),3,420,(1,.82,.55));area((-4.8,-1.5,.6),2,320,(1,.97,.92));area((1,1,7),6,420);area((3.2,-.2,3.2),1.1,260,(1,.97,.92),(1.4,-1.4,0))
    cam=bpy.data.cameras.new('c');cam.type='ORTHO';co=bpy.data.objects.new('c',cam);bpy.context.collection.objects.link(co);sc.camera=co
    bpy.context.view_layer.update()
    xs=[];ys=[]
    dg=bpy.context.evaluated_depsgraph_get()
    for o in bpy.context.scene.objects:
        if o.type in('MESH','CURVE'):
            for c in o.bound_box:
                v=o.matrix_world@mathutils.Vector(c);
                if o is ring: continue
                xs.append(v.x);ys.append(v.y)
    for v in ring.data.vertices:
        c=ring.matrix_world@v.co;xs.append(c.x);ys.append(c.y)
    cx,cy=(min(xs)+max(xs))/2,(min(ys)+max(ys))/2
    co.location=(cx,cy,8);cam.ortho_scale=max(max(xs)-min(xs),max(ys)-min(ys))*1.04
    sc.render.engine='CYCLES'
    try:
        pr=bpy.context.preferences.addons['cycles'].preferences;pr.compute_device_type='CUDA';pr.get_devices()
        for dv in pr.devices:dv.use=True
        sc.cycles.device='GPU'
    except Exception as ex: print('CPU',ex)
    sc.cycles.samples=192;sc.cycles.use_denoising=False;sc.cycles.max_bounces=8
    sc.render.film_transparent=True;sc.render.resolution_x=sc.render.resolution_y=1024
    sc.view_settings.view_transform='Standard';sc.view_settings.exposure=0
    sc.render.filepath=f'{out}/{name}.png';bpy.ops.render.render(write_still=True)
    if fire:
        # the fire alone, for its glow
        hold=bpy.data.materials.new('hold');hold.use_nodes=True;nt=hold.node_tree;h_=nt.nodes.new('ShaderNodeHoldout');nt.links.new(h_.outputs[0],nt.nodes['Material Output'].inputs[0])
        for o in sc.objects:
            if o.type in('MESH','CURVE') and (not o.data.materials or o.data.materials[0]!=glow):
                o.data.materials.clear();o.data.materials.append(hold)
            if o.type=='LIGHT':o.hide_render=True
        wld.node_tree.nodes['Background'].inputs[1].default_value=0
        sc.cycles.samples=32;sc.render.filepath=f'{out}/{name}-fire.png';bpy.ops.render.render(write_still=True)
# The icon's sizes: the smaller, the thicker ring and handle, and no script
# where it could not be read.
scene('L',.56,.31,-30,-12,'gold',True,.15,1.5,.27,'taper')
scene('M',.56,.36,-28,-12,'gold',True,.16,1.4,.31,'taper')
scene('S',.5,.4,-24,-12,'gold',False,.22,1.3,.36,'taper')
scene('T',.46,.46,-20,-12,'gold',False,.26,1.25,.42,'taper')
