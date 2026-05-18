import os
import io
import uuid
from datetime import datetime
from functools import wraps

from flask import (Flask, render_template, request, redirect, url_for,
                   flash, session, jsonify, send_from_directory)
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from PIL import Image

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'change-this-secret-key-in-production')
_db_url = os.environ.get('DATABASE_URL', '')
if _db_url:
    _db_url = _db_url.replace('postgres://', 'postgresql+pg8000://', 1)
    _db_url = _db_url.replace('postgresql://', 'postgresql+pg8000://', 1)
    app.config['SQLALCHEMY_DATABASE_URI'] = _db_url
else:
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///messenger.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = os.path.join('static', 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
online_users = {}  # sid -> user_id


# ── Models ────────────────────────────────────────────────────────────────────

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    display_name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    avatar = db.Column(db.String(256), default='')
    bio = db.Column(db.Text, default='')
    is_admin = db.Column(db.Boolean, default=False)
    is_banned = db.Column(db.Boolean, default=False)
    is_frozen = db.Column(db.Boolean, default=False)
    ip_address = db.Column(db.String(45), default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    online = db.Column(db.Boolean, default=False)
    last_seen = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'username': self.username,
            'display_name': self.display_name,
            'avatar': url_for('static', filename=self.avatar) if self.avatar else url_for('static', filename='default_avatar.svg'),
            'bio': self.bio,
            'online': self.online,
            'last_seen': self.last_seen.strftime('%d.%m.%Y %H:%M') if self.last_seen else '',
        }


class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    receiver_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    content = db.Column(db.Text, default='')
    image_path = db.Column(db.String(256), default='')
    message_type = db.Column(db.String(20), default='text')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    is_read = db.Column(db.Boolean, default=False)

    sender = db.relationship('User', foreign_keys=[sender_id])
    receiver = db.relationship('User', foreign_keys=[receiver_id])

    def to_dict(self):
        return {
            'id': self.id,
            'sender_id': self.sender_id,
            'receiver_id': self.receiver_id,
            'content': self.content,
            'image_url': url_for('static', filename=self.image_path) if self.image_path else '',
            'message_type': self.message_type,
            'created_at': self.created_at.strftime('%H:%M'),
            'created_date': self.created_at.strftime('%d.%m.%Y'),
            'is_read': self.is_read,
            'sender': self.sender.to_dict() if self.sender else None,
        }


class SupportTicket(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    subject = db.Column(db.String(200), nullable=False)
    status = db.Column(db.String(20), default='open')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship('User', backref='tickets')
    messages = db.relationship('SupportMessage', backref='ticket', lazy=True,
                                order_by='SupportMessage.created_at')


class SupportMessage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ticket_id = db.Column(db.Integer, db.ForeignKey('support_ticket.id'), nullable=False)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    sender = db.relationship('User')


class BannedIP(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    ip_address = db.Column(db.String(45), unique=True, nullable=False)
    reason = db.Column(db.Text, default='')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


# ── Helpers ───────────────────────────────────────────────────────────────────

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def compress_image(file_obj, max_size=(900, 900), quality=78):
    img = Image.open(file_obj)
    if img.mode in ('RGBA', 'P', 'LA'):
        img = img.convert('RGB')
    img.thumbnail(max_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=quality, optimize=True)
    buf.seek(0)
    return buf


def get_client_ip():
    forwarded = request.headers.get('X-Forwarded-For')
    if forwarded:
        return forwarded.split(',')[0].strip()
    return request.remote_addr or '0.0.0.0'


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        user = db.session.get(User, session['user_id'])
        if not user:
            session.clear()
            return redirect(url_for('login'))
        if user.is_banned:
            session.clear()
            flash('Ваш аккаунт заблокирован.', 'error')
            return redirect(url_for('login'))
        if user.is_frozen:
            session.clear()
            flash('Ваш аккаунт заморожен. Обратитесь в поддержку.', 'warning')
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        user = db.session.get(User, session['user_id'])
        if not user or not user.is_admin:
            flash('Доступ запрещён.', 'error')
            return redirect(url_for('chat'))
        return f(*args, **kwargs)
    return decorated


def conv_room(uid1, uid2):
    return f"conv_{min(uid1, uid2)}_{max(uid1, uid2)}"


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    if 'user_id' in session:
        return redirect(url_for('chat'))
    return redirect(url_for('login'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        return redirect(url_for('chat'))

    if request.method == 'POST':
        identifier = request.form.get('identifier', '').strip()
        password = request.form.get('password', '')
        ip = get_client_ip()

        if BannedIP.query.filter_by(ip_address=ip).first():
            flash('Ваш IP адрес заблокирован.', 'error')
            return render_template('login.html')

        user = User.query.filter(
            (User.username == identifier) | (User.email == identifier)
        ).first()

        if user and check_password_hash(user.password_hash, password):
            if user.is_banned:
                flash('Ваш аккаунт заблокирован.', 'error')
                return render_template('login.html')
            if user.is_frozen:
                flash('Ваш аккаунт заморожен. Обратитесь в поддержку.', 'warning')
                return render_template('login.html')
            session['user_id'] = user.id
            user.ip_address = ip
            db.session.commit()
            return redirect(url_for('chat'))

        flash('Неверный логин или пароль.', 'error')

    return render_template('login.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if 'user_id' in session:
        return redirect(url_for('chat'))

    if request.method == 'POST':
        username = request.form.get('username', '').strip().lower()
        display_name = request.form.get('display_name', '').strip()
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        ip = get_client_ip()

        if BannedIP.query.filter_by(ip_address=ip).first():
            flash('Ваш IP адрес заблокирован.', 'error')
            return render_template('register.html')

        if len(username) < 3 or len(username) > 20:
            flash('Юзернейм: от 3 до 20 символов.', 'error')
            return render_template('register.html')
        if not all(c.isalnum() or c in ('_', '.') for c in username):
            flash('Юзернейм: только буквы, цифры, _ и .', 'error')
            return render_template('register.html')
        if User.query.filter_by(username=username).first():
            flash('Этот юзернейм уже занят.', 'error')
            return render_template('register.html')
        if User.query.filter_by(email=email).first():
            flash('Этот email уже зарегистрирован.', 'error')
            return render_template('register.html')
        if len(password) < 6:
            flash('Пароль: минимум 6 символов.', 'error')
            return render_template('register.html')

        user = User(
            username=username,
            display_name=display_name or username,
            email=email,
            password_hash=generate_password_hash(password),
            ip_address=ip,
        )
        db.session.add(user)
        db.session.commit()
        session['user_id'] = user.id
        return redirect(url_for('chat'))

    return render_template('register.html')


@app.route('/logout')
def logout():
    uid = session.get('user_id')
    if uid:
        user = db.session.get(User, uid)
        if user:
            user.online = False
            user.last_seen = datetime.utcnow()
            db.session.commit()
    session.clear()
    return redirect(url_for('login'))


# ── Chat ──────────────────────────────────────────────────────────────────────

@app.route('/chat')
@login_required
def chat():
    user = db.session.get(User, session['user_id'])
    return render_template('chat.html', current_user=user)


@app.route('/api/conversations')
@login_required
def api_conversations():
    uid = session['user_id']
    sent_ids = {r[0] for r in db.session.query(Message.receiver_id).filter_by(sender_id=uid).distinct()}
    recv_ids = {r[0] for r in db.session.query(Message.sender_id).filter_by(receiver_id=uid).distinct()}
    partner_ids = sent_ids | recv_ids

    result = []
    for pid in partner_ids:
        partner = db.session.get(User, pid)
        if not partner:
            continue
        last_msg = Message.query.filter(
            ((Message.sender_id == uid) & (Message.receiver_id == pid)) |
            ((Message.sender_id == pid) & (Message.receiver_id == uid))
        ).order_by(Message.created_at.desc()).first()
        unread = Message.query.filter_by(sender_id=pid, receiver_id=uid, is_read=False).count()
        result.append({
            'partner': partner.to_dict(),
            'last_message': last_msg.to_dict() if last_msg else None,
            'unread_count': unread,
        })

    result.sort(key=lambda x: x['last_message']['created_date'] + x['last_message']['created_at']
                if x['last_message'] else '', reverse=True)
    return jsonify(result)


@app.route('/api/messages/<int:partner_id>')
@login_required
def api_messages(partner_id):
    uid = session['user_id']
    page = request.args.get('page', 1, type=int)

    msgs = Message.query.filter(
        ((Message.sender_id == uid) & (Message.receiver_id == partner_id)) |
        ((Message.sender_id == partner_id) & (Message.receiver_id == uid))
    ).order_by(Message.created_at.desc()).paginate(page=page, per_page=50, error_out=False)

    Message.query.filter_by(sender_id=partner_id, receiver_id=uid, is_read=False).update({'is_read': True})
    db.session.commit()

    return jsonify({
        'messages': [m.to_dict() for m in reversed(msgs.items)],
        'has_more': msgs.has_next,
    })


@app.route('/api/send_message', methods=['POST'])
@login_required
def api_send_message():
    uid = session['user_id']
    receiver_id = request.form.get('receiver_id', type=int)
    content = request.form.get('content', '').strip()

    if not receiver_id:
        return jsonify({'error': 'no receiver'}), 400

    receiver = db.session.get(User, receiver_id)
    if not receiver:
        return jsonify({'error': 'user not found'}), 404

    image_path = ''
    msg_type = 'text'

    if 'image' in request.files:
        f = request.files['image']
        if f and f.filename and allowed_file(f.filename):
            compressed = compress_image(f)
            fname = f"{uuid.uuid4().hex}.jpg"
            fpath = os.path.join(app.config['UPLOAD_FOLDER'], 'messages', fname)
            os.makedirs(os.path.dirname(fpath), exist_ok=True)
            with open(fpath, 'wb') as fp:
                fp.write(compressed.read())
            image_path = f"uploads/messages/{fname}"
            msg_type = 'mixed' if content else 'image'

    if not content and not image_path:
        return jsonify({'error': 'empty message'}), 400

    msg = Message(sender_id=uid, receiver_id=receiver_id,
                  content=content, image_path=image_path, message_type=msg_type)
    db.session.add(msg)
    db.session.commit()

    room = conv_room(uid, receiver_id)
    socketio.emit('new_message', msg.to_dict(), room=room)
    return jsonify(msg.to_dict())


@app.route('/api/search_users')
@login_required
def api_search_users():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify([])
    uid = session['user_id']
    users = User.query.filter(
        (User.username.ilike(f'%{q}%') | User.display_name.ilike(f'%{q}%')),
        User.id != uid,
        User.is_banned == False,
    ).limit(20).all()
    return jsonify([u.to_dict() for u in users])


@app.route('/api/user/<int:user_id>')
@login_required
def api_user(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({'error': 'not found'}), 404
    return jsonify(user.to_dict())


# ── Profile ───────────────────────────────────────────────────────────────────

@app.route('/profile/<username>')
@login_required
def profile(username):
    profile_user = User.query.filter_by(username=username).first_or_404()
    current_user = db.session.get(User, session['user_id'])
    return render_template('profile.html', profile_user=profile_user, current_user=current_user)


@app.route('/profile/edit', methods=['GET', 'POST'])
@login_required
def edit_profile():
    user = db.session.get(User, session['user_id'])

    if request.method == 'POST':
        dn = request.form.get('display_name', '').strip()
        bio = request.form.get('bio', '').strip()[:300]
        if dn:
            user.display_name = dn
        user.bio = bio

        if 'avatar' in request.files:
            f = request.files['avatar']
            if f and f.filename and allowed_file(f.filename):
                compressed = compress_image(f, max_size=(400, 400), quality=85)
                fname = f"avatar_{user.id}_{uuid.uuid4().hex[:8]}.jpg"
                fpath = os.path.join(app.config['UPLOAD_FOLDER'], 'avatars', fname)
                os.makedirs(os.path.dirname(fpath), exist_ok=True)
                with open(fpath, 'wb') as fp:
                    fp.write(compressed.read())
                user.avatar = f"uploads/avatars/{fname}"

        db.session.commit()
        flash('Профиль обновлён.', 'success')
        return redirect(url_for('profile', username=user.username))

    return render_template('profile_edit.html', current_user=user)


# ── Support ───────────────────────────────────────────────────────────────────

@app.route('/support')
@login_required
def support():
    user = db.session.get(User, session['user_id'])
    tickets = SupportTicket.query.filter_by(user_id=user.id).order_by(SupportTicket.created_at.desc()).all()
    return render_template('support/index.html', current_user=user, tickets=tickets)


@app.route('/support/new', methods=['GET', 'POST'])
@login_required
def new_ticket():
    user = db.session.get(User, session['user_id'])

    if request.method == 'POST':
        subject = request.form.get('subject', '').strip()
        content = request.form.get('message', '').strip()
        if not subject or not content:
            flash('Заполните все поля.', 'error')
        else:
            ticket = SupportTicket(user_id=user.id, subject=subject)
            db.session.add(ticket)
            db.session.flush()
            msg = SupportMessage(ticket_id=ticket.id, sender_id=user.id, content=content)
            db.session.add(msg)
            db.session.commit()
            socketio.emit('new_support_ticket', {
                'ticket_id': ticket.id,
                'user': user.to_dict(),
                'subject': subject,
            }, room='admin_room')
            flash('Обращение создано. Ответим в ближайшее время.', 'success')
            return redirect(url_for('view_ticket', ticket_id=ticket.id))

    return render_template('support/new.html', current_user=user)


@app.route('/support/ticket/<int:ticket_id>', methods=['GET', 'POST'])
@login_required
def view_ticket(ticket_id):
    user = db.session.get(User, session['user_id'])
    ticket = db.session.get(SupportTicket, ticket_id)
    if not ticket:
        flash('Тикет не найден.', 'error')
        return redirect(url_for('support'))
    if ticket.user_id != user.id and not user.is_admin:
        flash('Доступ запрещён.', 'error')
        return redirect(url_for('support'))

    if request.method == 'POST':
        content = request.form.get('content', '').strip()
        if content:
            smsg = SupportMessage(ticket_id=ticket.id, sender_id=user.id, content=content)
            db.session.add(smsg)
            if not user.is_admin and ticket.status == 'closed':
                ticket.status = 'open'
            db.session.commit()
            socketio.emit('support_reply', {
                'ticket_id': ticket.id,
                'sender': user.to_dict(),
                'content': content,
                'created_at': smsg.created_at.strftime('%H:%M %d.%m.%Y'),
            }, room=f'ticket_{ticket_id}')
            if user.is_admin:
                # notify user
                u_sids = [sid for sid, uid in online_users.items() if uid == ticket.user_id]
                for sid in u_sids:
                    socketio.emit('ticket_reply_notify', {
                        'ticket_id': ticket.id,
                        'subject': ticket.subject,
                    }, room=sid)

    return render_template('support/ticket.html', current_user=user, ticket=ticket)


@app.route('/support/ticket/<int:ticket_id>/close', methods=['POST'])
@admin_required
def close_ticket(ticket_id):
    ticket = db.session.get(SupportTicket, ticket_id)
    if ticket:
        ticket.status = 'closed'
        db.session.commit()
        flash('Тикет закрыт.', 'success')
    return redirect(url_for('view_ticket', ticket_id=ticket_id))


# ── Admin ─────────────────────────────────────────────────────────────────────

@app.route('/admin')
@admin_required
def admin_dashboard():
    user = db.session.get(User, session['user_id'])
    return render_template('admin/dashboard.html',
        current_user=user,
        total_users=User.query.count(),
        total_messages=Message.query.count(),
        open_tickets=SupportTicket.query.filter_by(status='open').count(),
        online_count=User.query.filter_by(online=True).count(),
        recent_users=User.query.order_by(User.created_at.desc()).limit(8).all(),
    )


@app.route('/admin/users')
@admin_required
def admin_users():
    user = db.session.get(User, session['user_id'])
    q = request.args.get('q', '')
    query = User.query
    if q:
        query = query.filter(
            User.username.ilike(f'%{q}%') |
            User.display_name.ilike(f'%{q}%') |
            User.email.ilike(f'%{q}%') |
            User.ip_address.ilike(f'%{q}%')
        )
    users = query.order_by(User.created_at.desc()).all()
    banned_ips = BannedIP.query.order_by(BannedIP.created_at.desc()).all()
    return render_template('admin/users.html', current_user=user, users=users,
                           banned_ips=banned_ips, search=q)


@app.route('/admin/user/<int:user_id>/action', methods=['POST'])
@admin_required
def admin_user_action(user_id):
    target = db.session.get(User, user_id)
    if not target:
        flash('Пользователь не найден.', 'error')
        return redirect(url_for('admin_users'))

    action = request.form.get('action')

    if action == 'ban':
        target.is_banned = True
        if target.ip_address and not BannedIP.query.filter_by(ip_address=target.ip_address).first():
            db.session.add(BannedIP(ip_address=target.ip_address, reason=f'ban user {target.username}'))
        db.session.commit()
        flash(f'{target.username} заблокирован.', 'success')

    elif action == 'unban':
        target.is_banned = False
        db.session.commit()
        flash(f'{target.username} разблокирован.', 'success')

    elif action == 'freeze':
        target.is_frozen = True
        db.session.commit()
        flash(f'Аккаунт {target.username} заморожен.', 'success')

    elif action == 'unfreeze':
        target.is_frozen = False
        db.session.commit()
        flash(f'Аккаунт {target.username} разморожен.', 'success')

    elif action == 'change_name':
        new_name = request.form.get('display_name', '').strip()
        if new_name:
            target.display_name = new_name
            db.session.commit()
            flash(f'Имя изменено на «{new_name}».', 'success')

    elif action == 'change_username':
        new_uname = request.form.get('new_username', '').strip().lower()
        if new_uname:
            if User.query.filter_by(username=new_uname).first():
                flash('Юзернейм уже занят.', 'error')
            else:
                target.username = new_uname
                db.session.commit()
                flash(f'Юзернейм изменён на @{new_uname}.', 'success')

    elif action == 'change_avatar':
        if 'avatar' in request.files:
            f = request.files['avatar']
            if f and f.filename and allowed_file(f.filename):
                compressed = compress_image(f, max_size=(400, 400), quality=85)
                fname = f"avatar_{target.id}_{uuid.uuid4().hex[:8]}.jpg"
                fpath = os.path.join(app.config['UPLOAD_FOLDER'], 'avatars', fname)
                os.makedirs(os.path.dirname(fpath), exist_ok=True)
                with open(fpath, 'wb') as fp:
                    fp.write(compressed.read())
                target.avatar = f"uploads/avatars/{fname}"
                db.session.commit()
                flash('Аватар изменён.', 'success')

    elif action == 'ban_ip':
        ip = request.form.get('ip_to_ban', '').strip()
        reason = request.form.get('ban_reason', '').strip()
        if ip:
            if not BannedIP.query.filter_by(ip_address=ip).first():
                db.session.add(BannedIP(ip_address=ip, reason=reason))
                db.session.commit()
                flash(f'IP {ip} заблокирован.', 'success')
            else:
                flash('IP уже заблокирован.', 'info')

    return redirect(url_for('admin_users') + (f'?q={request.form.get("search_q", "")}'))


@app.route('/admin/ban_ip', methods=['POST'])
@admin_required
def admin_ban_ip():
    ip = request.form.get('ip', '').strip()
    reason = request.form.get('reason', '').strip()
    if ip and not BannedIP.query.filter_by(ip_address=ip).first():
        db.session.add(BannedIP(ip_address=ip, reason=reason))
        db.session.commit()
        flash(f'IP {ip} заблокирован.', 'success')
    return redirect(url_for('admin_users'))


@app.route('/admin/unban_ip/<int:ban_id>', methods=['POST'])
@admin_required
def admin_unban_ip(ban_id):
    ban = db.session.get(BannedIP, ban_id)
    if ban:
        ip = ban.ip_address
        db.session.delete(ban)
        db.session.commit()
        flash(f'IP {ip} разблокирован.', 'success')
    return redirect(url_for('admin_users'))


@app.route('/admin/messages')
@admin_required
def admin_messages():
    user = db.session.get(User, session['user_id'])
    q = request.args.get('q', '').strip()
    uid_filter = request.args.get('uid', type=int)

    query = Message.query
    if q:
        found_user = User.query.filter(
            User.username.ilike(f'%{q}%') | User.display_name.ilike(f'%{q}%')
        ).first()
        if found_user:
            query = query.filter(
                (Message.sender_id == found_user.id) | (Message.receiver_id == found_user.id)
            )
    elif uid_filter:
        query = query.filter(
            (Message.sender_id == uid_filter) | (Message.receiver_id == uid_filter)
        )

    messages = query.order_by(Message.created_at.desc()).limit(100).all()
    return render_template('admin/messages.html', current_user=user, messages=messages, search=q)


@app.route('/admin/support')
@admin_required
def admin_support():
    user = db.session.get(User, session['user_id'])
    status = request.args.get('status', 'open')
    tickets = SupportTicket.query.filter_by(status=status).order_by(SupportTicket.created_at.desc()).all()
    return render_template('admin/support.html', current_user=user, tickets=tickets, status_filter=status)


# ── Socket.IO ─────────────────────────────────────────────────────────────────

@socketio.on('connect')
def on_connect():
    if 'user_id' not in session:
        return False
    uid = session['user_id']
    user = db.session.get(User, uid)
    if not user or user.is_banned:
        return False
    online_users[request.sid] = uid
    user.online = True
    user.last_seen = datetime.utcnow()
    db.session.commit()
    if user.is_admin:
        join_room('admin_room')
    emit('user_status', {'user_id': uid, 'online': True}, broadcast=True)


@socketio.on('disconnect')
def on_disconnect():
    uid = online_users.pop(request.sid, None)
    if uid:
        still = uid in online_users.values()
        if not still:
            user = db.session.get(User, uid)
            if user:
                user.online = False
                user.last_seen = datetime.utcnow()
                db.session.commit()
            emit('user_status', {'user_id': uid, 'online': False}, broadcast=True)


@socketio.on('join_conversation')
def on_join_conv(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    pid = data.get('partner_id')
    if pid:
        join_room(conv_room(uid, pid))


@socketio.on('leave_conversation')
def on_leave_conv(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    pid = data.get('partner_id')
    if pid:
        leave_room(conv_room(uid, pid))


@socketio.on('typing')
def on_typing(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    pid = data.get('partner_id')
    if pid:
        emit('typing', {'user_id': uid, 'typing': data.get('typing', False)},
             room=conv_room(uid, pid), include_self=False)


@socketio.on('join_support_ticket')
def on_join_ticket(data):
    tid = data.get('ticket_id')
    if tid:
        join_room(f'ticket_{tid}')


# ── WebRTC signaling ──────────────────────────────────────────────────────────

def sids_for_user(uid):
    return [s for s, u in online_users.items() if u == uid]


@socketio.on('call_offer')
def on_call_offer(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    caller = db.session.get(User, uid)
    target_id = data.get('target_id')
    for sid in sids_for_user(target_id):
        emit('incoming_call', {
            'caller_id': uid,
            'caller_name': caller.display_name,
            'caller_avatar': url_for('static', filename=caller.avatar) if caller.avatar else '',
            'offer': data.get('offer'),
            'call_type': data.get('call_type', 'audio'),
        }, room=sid)


@socketio.on('call_answer')
def on_call_answer(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    for sid in sids_for_user(data.get('caller_id')):
        emit('call_answered', {'answerer_id': uid, 'answer': data.get('answer')}, room=sid)


@socketio.on('ice_candidate')
def on_ice(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    for sid in sids_for_user(data.get('target_id')):
        emit('ice_candidate', {'sender_id': uid, 'candidate': data.get('candidate')}, room=sid)


@socketio.on('call_reject')
def on_call_reject(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    for sid in sids_for_user(data.get('caller_id')):
        emit('call_rejected', {'user_id': uid}, room=sid)


@socketio.on('call_end')
def on_call_end(data):
    if 'user_id' not in session:
        return
    uid = session['user_id']
    for sid in sids_for_user(data.get('target_id')):
        emit('call_ended', {'user_id': uid}, room=sid)


# ── Init ──────────────────────────────────────────────────────────────────────

def init_db():
    db.create_all()
    os.makedirs(os.path.join('static', 'uploads', 'avatars'), exist_ok=True)
    os.makedirs(os.path.join('static', 'uploads', 'messages'), exist_ok=True)
    if not User.query.filter_by(username='zer0tune').first():
        admin = User(
            username='zer0tune',
            display_name='Admin',
            email='admin@nuchebazar.net',
            password_hash=generate_password_hash('zxcfriday15'),
            is_admin=True,
        )
        db.session.add(admin)
        db.session.commit()
        print('[+] Admin created: zer0tune / zxcfriday15')

# Вызывается и через gunicorn и через python app.py
import time
with app.app_context():
    for _attempt in range(5):
        try:
            init_db()
            break
        except Exception as e:
            print(f'[DB] attempt {_attempt+1} failed: {e}')
            time.sleep(2)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, debug=False, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
